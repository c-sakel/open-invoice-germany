/**
 * Phase 17b, Task 3 — Lieferschein-Entwurf in REST v1, interner Route, MCP, Vorlagen und
 * Fehler-Mapping (Testjahr 2146 ueber die Systemuhr: eigenes Nummernpraefix).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { updateDraftDeliveryNote } from "@/domain/delivery-note/update";
import { DeliveryNoteNotDraftError, DeliveryNoteValidationError, DeliveryNoteError } from "@/domain/delivery-note/errors";
import { withDraftPreviewSnapshots } from "@/domain/delivery-note/parties";
import { OverDeliveryError } from "@/domain/delivery-note/quantities";
import { setDeliveryNoteStatus } from "@/domain/document/status";
import { mapApiError } from "@/api/errors";
import { getDocumentFile } from "@/api/files";
import { applyTemplate } from "@/domain/template/apply";
import { applyTemplateAction } from "@/app/actions/templates-doc";
import { server } from "@/mcp/server";
import { POST as v1Post } from "@/app/api/v1/DeliveryNote/route";
import { PATCH as v1Patch } from "@/app/api/v1/DeliveryNote/[id]/route";
import { POST as v1Status } from "@/app/api/v1/DeliveryNote/[id]/status/route";
import { PATCH as internalPatch } from "@/app/api/delivery-notes/[id]/route";
import { POST as internalPost } from "@/app/api/delivery-notes/route";
import { POST as internalStatus } from "@/app/api/delivery-notes/[id]/status/route";
import { GET as internalPdf } from "@/app/api/delivery-notes/[id]/pdf/route";

interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<ToolResult> }> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

const NOW = new Date("2146-03-02T10:00:00Z");
let orgId: string;
let customerId: string;
let writeToken: string;
let readToken: string;
let otherWriteToken: string;

function req(url: string, token: string, method = "GET", body?: unknown) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
function plain(method: string, body?: unknown) {
  return new Request("http://x", { method, headers: { "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const ctx1 = (id: string) => ({ params: Promise.resolve({ id }) });
const line = (qty = 1000, extra: Record<string, unknown> = {}) => ({
  description: "Kabel", quantityMilli: qty, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, ...extra,
});

async function draft(lines = [line()]) {
  return createDeliveryNote(orgId, { customerId, draft: true, lines }, { now: NOW });
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({ data: { legalName: "LS-Routen GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin" } });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const d of [NOW, new Date()]) {
    await updateNumberRange(orgId, "DELIVERY_NOTE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "LSR-", seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", d);
  }
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Routen Kunde AG", addressLine1: "Weg 1", postalCode: "54321", city: "Wien", type: "BUSINESS" } })).id;
  const other = await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "Teststr. 2", postalCode: "12345", city: "Berlin" } });
  writeToken = (await createApiKey(orgId, { name: "w", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "r", scopes: ["read"] })).token;
  otherWriteToken = (await createApiKey(other.id, { name: "o", scopes: ["read", "write"] })).token;
});

beforeEach(() => resetRateLimits());

describe("REST v1", () => {
  it("POST mit draft:true -> 201 DRAFT ohne Nummer; ohne draft -> CREATED", async () => {
    const res = await v1Post(req("http://x", writeToken, "POST", { customerId, draft: true, lines: [line()] }), { params: Promise.resolve({}) });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.status).toBe("DRAFT");
    expect(data.number).toBeNull();
    const res2 = await v1Post(req("http://x", writeToken, "POST", { customerId, lines: [line()] }), { params: Promise.resolve({}) });
    expect((await res2.json()).data.status).toBe("CREATED");
  });

  it("PATCH Entwurf 200 mit neuen Positionen; read-Key 403; CREATED 409; fremde Org 404; Body 400", async () => {
    const dn = await draft();
    const ok = await v1Patch(req("http://x", writeToken, "PATCH", { lines: [line(2000, { description: "Neu" })] }), ctx1(dn.id));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.lines[0].description).toBe("Neu");
    expect((await v1Patch(req("http://x", readToken, "PATCH", { notes: "x" }), ctx1(dn.id))).status).toBe(403);
    expect((await v1Patch(req("http://x", otherWriteToken, "PATCH", { notes: "x" }), ctx1(dn.id))).status).toBe(404);
    expect((await v1Patch(req("http://x", writeToken, "PATCH", { sourceType: "QUOTE" }), ctx1(dn.id))).status).toBe(400);
    await setDeliveryNoteStatus(orgId, dn.id, "CREATED", { actor: "t", now: NOW });
    const conflict = await v1Patch(req("http://x", writeToken, "PATCH", { notes: "x" }), ctx1(dn.id));
    expect(conflict.status).toBe(409);
  });

  it("leerer PATCH-Body auf einen Entwurf -> 400 mit Meldung", async () => {
    const dn = await draft();
    const res = await v1Patch(req("http://x", writeToken, "PATCH", {}), ctx1(dn.id));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Keine Änderung angegeben.");
  });

  it("Status MARK_CREATED bei Ueberlieferung -> 409, Entwurf bleibt", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Kabel", quantityMilli: 2000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }, { now: NOW });
    const ql = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
    const l = line(3000, { sourceType: "QUOTE", sourceId: q.id, sourceLineId: ql.id });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: q.id, lines: [l] }, { now: NOW });
    const res = await v1Status(req("http://x", writeToken, "POST", { action: "MARK_CREATED" }), ctx1(dn.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect((await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: dn.id } })).status).toBe("DRAFT");
  });
});

describe("interne Routen", () => {
  it("PATCH 200 / 409 / 400 / 404", async () => {
    const dn = await draft();
    expect((await internalPatch(plain("PATCH", { notes: "intern" }), ctx1(dn.id))).status).toBe(200);
    expect((await internalPatch(plain("PATCH", { lines: [] }), ctx1(dn.id))).status).toBe(400);
    const broken = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{nicht json" });
    expect((await internalPatch(broken("http://x"), ctx1(dn.id))).status).toBe(400);
    expect((await internalStatus(broken("http://x"), ctx1(dn.id))).status).toBe(400);
    expect((await internalPost(broken("http://x"))).status).toBe(400);
    expect((await internalPatch(plain("PATCH", { notes: "x" }), ctx1("gibtsnicht"))).status).toBe(404);
    await setDeliveryNoteStatus(orgId, dn.id, "CREATED", { actor: "t", now: NOW });
    expect((await internalPatch(plain("PATCH", { notes: "x" }), ctx1(dn.id))).status).toBe(409);
  });

  it("Status bei Ueberlieferung -> 409", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Kabel", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }, { now: NOW });
    const ql = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: q.id, lines: [line(5000, { sourceType: "QUOTE", sourceId: q.id, sourceLineId: ql.id })] }, { now: NOW });
    const res = await internalStatus(plain("POST", { action: "MARK_CREATED" }), ctx1(dn.id));
    expect(res.status).toBe(409);
  });

  it("PDF eines Entwurfs: 200 (Vorschau), kein 500; getDocumentFile ebenso", async () => {
    const dn = await draft();
    const res = await internalPdf(plain("GET"), ctx1(dn.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(500);
    const file = await getDocumentFile(orgId, "DELIVERY_NOTE", dn.id, "pdf");
    expect(file.buffer.byteLength).toBeGreaterThan(500);
  });
});

describe("PDF-Vorschau eines Entwurfs: gewaehlte Lieferanschrift", () => {
  it("Snapshots live aus shippingAddressId/contactPersonId, nicht aus der Default-Adresse; nichts wird gespeichert", async () => {
    await dbInternal.customerAddress.create({ data: { orgId, customerId, type: "SHIPPING", isDefault: true, addressLine1: "Standardweg 1", postalCode: "10115", city: "Berlin", countryCode: "DE" } });
    const chosen = await dbInternal.customerAddress.create({ data: { orgId, customerId, type: "SHIPPING", isDefault: false, addressLine1: "Wunschrampe 7", postalCode: "20095", city: "Hamburg", countryCode: "DE" } });
    const contact = await dbInternal.contactPerson.create({ data: { orgId, customerId, firstName: "Erika", lastName: "Vorschau" } });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, shippingAddressId: chosen.id, contactPersonId: contact.id, lines: [line()] }, { now: NOW });
    const row = await dbInternal.deliveryNote.findFirstOrThrow({ where: { id: dn.id }, include: { customer: true } });
    expect(row.buyerSnapshotJson).toBeNull();
    const preview = await withDraftPreviewSnapshots(row, row.customer);
    const buyer = JSON.parse(preview.buyerSnapshotJson ?? "{}") as { shippingAddress?: { addressLine1?: string } };
    expect(buyer.shippingAddress?.addressLine1).toBe("Wunschrampe 7");
    expect(JSON.parse(preview.contactSnapshotJson ?? "{}")).toMatchObject({ lastName: "Vorschau" });
    const pdf = await internalPdf(plain("GET"), ctx1(dn.id));
    expect(pdf.status).toBe(200);
    const after = await dbInternal.deliveryNote.findFirstOrThrow({ where: { id: dn.id }, select: { buyerSnapshotJson: true, contactSnapshotJson: true } });
    expect(after).toEqual({ buyerSnapshotJson: null, contactSnapshotJson: null });
    // CREATED-Beleg mit Snapshots bleibt unveraendert.
    expect(await withDraftPreviewSnapshots({ ...row, status: "CREATED" }, row.customer)).toMatchObject({ buyerSnapshotJson: null });
  });
});

describe("Fehler-Mapping", () => {
  it("neue Lieferschein-Fehlerklassen", () => {
    expect(mapApiError(new OverDeliveryError("zu viel")).status).toBe(409);
    expect(mapApiError(new DeliveryNoteNotDraftError()).status).toBe(409);
    expect(mapApiError(new DeliveryNoteError("x")).status).toBe(409);
    expect(mapApiError(new DeliveryNoteValidationError("x")).status).toBe(400);
  });
});

describe("T2-Nachtrag: Update", () => {
  it("SENT/CANCELLED -> DeliveryNoteNotDraftError", async () => {
    for (const target of ["SENT", "CANCELLED"] as const) {
      const dn = await draft();
      await setDeliveryNoteStatus(orgId, dn.id, "CREATED", { actor: "t", now: NOW });
      if (target === "SENT") await setDeliveryNoteStatus(orgId, dn.id, "SENT", { actor: "t", now: NOW });
      else await setDeliveryNoteStatus(orgId, dn.id, "CANCELLED", { actor: "t", now: NOW });
      await expect(updateDraftDeliveryNote(orgId, dn.id, { notes: "x" })).rejects.toBeInstanceOf(DeliveryNoteNotDraftError);
      const res = await v1Patch(req("http://x", writeToken, "PATCH", { notes: "x" }), ctx1(dn.id));
      expect(res.status).toBe(409);
    }
  });

  it("Zeilenquelle muss zur Quelle des Kopfes passen -> Validierungsfehler", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Kabel", quantityMilli: 5000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }, { now: NOW });
    const ql = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: q.id, lines: [line(1000, { sourceType: "QUOTE", sourceId: q.id, sourceLineId: ql.id })] }, { now: NOW });
    await expect(
      updateDraftDeliveryNote(orgId, dn.id, { lines: [line(1000, { sourceType: "QUOTE", sourceId: "fremd", sourceLineId: ql.id })] }),
    ).rejects.toBeInstanceOf(DeliveryNoteValidationError);
    // Entwurf ohne Quelle darf keine Quellbezuege annehmen
    const free = await draft();
    await expect(
      updateDraftDeliveryNote(orgId, free.id, { lines: [line(1000, { sourceType: "QUOTE", sourceId: q.id, sourceLineId: ql.id })] }),
    ).rejects.toBeInstanceOf(DeliveryNoteValidationError);
  });

  it("mehrere Zeilen mit derselben sourceLineId werden summiert und gegen die Restmenge geprueft", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Kabel", quantityMilli: 5000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }, { now: NOW });
    const ql = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
    const src = { sourceType: "QUOTE" as const, sourceId: q.id, sourceLineId: ql.id };
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: q.id, lines: [line(3000, src)] }, { now: NOW });
    await updateDraftDeliveryNote(orgId, dn.id, { lines: [line(3000, src), line(3000, src)] });
    await expect(setDeliveryNoteStatus(orgId, dn.id, "CREATED", { actor: "t", now: NOW })).rejects.toBeInstanceOf(OverDeliveryError);
    await updateDraftDeliveryNote(orgId, dn.id, { lines: [line(2000, src), line(3000, src)] });
    const done = await setDeliveryNoteStatus(orgId, dn.id, "CREATED", { actor: "t", now: NOW });
    expect(done.status).toBe("CREATED");
  });
});

describe("MCP", () => {
  it("create_delivery_note draft -> Entwurf mit ID; update_delivery_note; CREATED -> Fehlertext", async () => {
    const res = await callTool("create_delivery_note", { customer: "Routen Kunde AG", draft: true, lines: [{ description: "Ding", quantity: 1, unitPriceEuro: 5 }] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Entwurf");
    const id = /ID (\S+?)\)/.exec(res.content[0].text)?.[1];
    expect(id).toBeTruthy();
    const upd = await callTool("update_delivery_note", { id, lines: [{ description: "Anders", quantity: 3, unitPriceEuro: 5 }] });
    expect(upd.isError).toBeFalsy();
    const lines = await dbInternal.deliveryNoteLine.findMany({ where: { deliveryNoteId: id } });
    expect(lines.map((l) => l.description)).toEqual(["Anders"]);
    await setDeliveryNoteStatus(orgId, id as string, "CREATED", { actor: "t", now: NOW });
    const again = await callTool("update_delivery_note", { id, notes: "nein" });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("Entwurf");
  });

  it("update_delivery_note setzt und leert das Versanddatum; ungueltiges Datum -> Tool-Fehler", async () => {
    const dn = await draft();
    const set = await callTool("update_delivery_note", { id: dn.id, shippingDate: "2026-12-01" });
    expect(set.isError).toBeFalsy();
    const after = await dbInternal.deliveryNote.findFirst({ where: { id: dn.id }, select: { shippingDate: true } });
    expect(after?.shippingDate?.toISOString().slice(0, 10)).toBe("2026-12-01");
    const cleared = await callTool("update_delivery_note", { id: dn.id, shippingDate: "" });
    expect(cleared.isError).toBeFalsy();
    const gone = await dbInternal.deliveryNote.findFirst({ where: { id: dn.id }, select: { shippingDate: true } });
    expect(gone?.shippingDate).toBeNull();
    const bad = await callTool("update_delivery_note", { id: dn.id, shippingDate: "kein-datum" });
    expect(bad.isError).toBe(true);
  });

  it("set_document_status MARK_CREATED bei Ueberlieferung -> ctx.fail mit Meldung", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Kabel", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }, { now: NOW });
    const ql = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: q.id, lines: [line(9000, { sourceType: "QUOTE", sourceId: q.id, sourceLineId: ql.id })] }, { now: NOW });
    const res = await callTool("set_document_status", { type: "DELIVERY_NOTE", document: dn.id, action: "MARK_CREATED" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("Unerwarteter Fehler");
  });

  it("update_delivery_note erhaelt den Quellbezug; MARK_CREATED mit Uebermenge -> OverDeliveryError", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Kabel", quantityMilli: 5000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }, { now: NOW });
    const ql = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
    const src = { sourceType: "QUOTE" as const, sourceId: q.id, sourceLineId: ql.id };
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: q.id, lines: [line(1000, src)] }, { now: NOW });
    const upd = await callTool("update_delivery_note", { id: dn.id, lines: [{ description: "Kabel", quantity: 9, unitPriceEuro: 10, taxRatePercent: 19 }] });
    expect(upd.isError).toBeFalsy();
    const kept = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id } });
    expect(kept.sourceLineId).toBe(ql.id);
    await expect(setDeliveryNoteStatus(orgId, dn.id, "CREATED", { actor: "t", now: NOW })).rejects.toBeInstanceOf(OverDeliveryError);
  });

  it("Lieferdatum/Versanddatum leeren: REST (null), intern (null) und MCP (leerer String)", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, deliveryDate: new Date("2146-03-10"), shippingDate: new Date("2146-03-11"), lines: [line()] }, { now: NOW });
    expect((await v1Patch(req("http://x", writeToken, "PATCH", { deliveryDate: null, shippingDate: null }), ctx1(dn.id))).status).toBe(200);
    const cleared = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: dn.id }, select: { deliveryDate: true, shippingDate: true } });
    expect(cleared).toEqual({ deliveryDate: null, shippingDate: null });
    const set = await updateDraftDeliveryNote(orgId, dn.id, { deliveryDate: "2146-04-01" }, { now: NOW });
    expect(set.deliveryDate).not.toBeNull();
    expect((await internalPatch(plain("PATCH", { deliveryDate: null }), ctx1(dn.id))).status).toBe(200);
    expect((await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: dn.id }, select: { deliveryDate: true } })).deliveryDate).toBeNull();
    await updateDraftDeliveryNote(orgId, dn.id, { deliveryDate: "2146-04-02" }, { now: NOW });
    const mcp = await callTool("update_delivery_note", { id: dn.id, deliveryDate: "" });
    expect(mcp.isError).toBeFalsy();
    expect((await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: dn.id }, select: { deliveryDate: true } })).deliveryDate).toBeNull();
  });

  it("MCP: ungueltiges Lieferdatum -> Validierungsfehler statt stillem Verwerfen", async () => {
    const d = await draft();
    const upd = await callTool("update_delivery_note", { id: d.id, deliveryDate: "kein-datum" });
    expect(upd.isError).toBe(true);
    expect(upd.content[0].text).toContain("kein-datum");
    expect(upd.content[0].text).not.toContain("Unerwarteter Fehler");
    const created = await callTool("create_delivery_note", { customer: "Routen Kunde AG", draft: true, deliveryDate: "31.31.2146", lines: [{ description: "x", quantity: 1, unitPriceEuro: 5 }] });
    expect(created.isError).toBe(true);
    expect(created.content[0].text).toContain("31.31.2146");
  });

  it("create/update_delivery_note: Zod-Fehler als Validierungsfehler statt Unerwarteter Fehler", async () => {
    const bad = await callTool("create_delivery_note", { customer: "Routen Kunde AG", lines: [{ description: "x", quantity: 0, unitPriceEuro: 5 }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).not.toContain("Unerwarteter Fehler");
    const d = await draft();
    const badUpd = await callTool("update_delivery_note", { id: d.id, lines: [{ description: "x", quantity: 0, unitPriceEuro: 5 }] });
    expect(badUpd.isError).toBe(true);
    expect(badUpd.content[0].text).not.toContain("Unerwarteter Fehler");
  });

  it("Positionen mit productName tragen die Artikelnummer", async () => {
    await dbInternal.product.create({ data: { orgId, name: "Artikel A", articleNumber: "A-100", netPriceCents: 500, unit: "C62", taxRate: 19 } });
    const res = await callTool("create_delivery_note", { customer: "Routen Kunde AG", draft: true, lines: [{ description: "x", quantity: 1, productName: "Artikel A" }] });
    const id = /ID (\S+?)\)/.exec(res.content[0].text)?.[1];
    const l = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: id } });
    expect(l.articleNumber).toBe("A-100");
  });
});

describe("Vorlagen", () => {
  it("applyTemplate Lieferschein -> DRAFT ohne Nummer", async () => {
    const tpl = await dbInternal.documentTemplate.create({
      data: { orgId, docType: "DELIVERY_NOTE", name: "LS-Vorlage", payloadJson: JSON.stringify({ lines: [{ lineType: "ITEM", description: "Vorlage", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }) },
    });
    const { id } = await applyTemplate(orgId, tpl.id, { customerId }, "t");
    const dn = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id } });
    expect(dn.status).toBe("DRAFT");
    expect(dn.number).toBeNull();
  });

  it("applyTemplateAction -> editHref auf den Lieferschein-Editor", async () => {
    const tpl = await dbInternal.documentTemplate.create({
      data: { orgId, docType: "DELIVERY_NOTE", name: "LS-Vorlage 2", payloadJson: JSON.stringify({ customerId, lines: [{ lineType: "ITEM", description: "V", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] }) },
    });
    const res = await applyTemplateAction({ id: tpl.id });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.editHref).toMatch(/^\/lieferscheine\/[^/]+\/bearbeiten$/);
  });
});
