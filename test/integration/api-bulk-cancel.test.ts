/**
 * Phase 18d Task 7: POST /api/v1/Invoice/bulk-cancel und MCP cancel_invoices (Domain aus 18c).
 * Testjahr 2193, Belegnummern-Praefix D18D7- (je Org eigener Nummernkreis ohne Jahresreset).
 */
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createInvoiceSchema } from "@/schemas";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { POST as BulkCancelPost } from "@/app/api/v1/Invoice/bulk-cancel/route";
import { GET as InvoiceGet } from "@/app/api/v1/Invoice/[id]/route";
import { server } from "@/mcp/server";

const NOW = new Date("2193-05-01T10:00:00.000Z");
let orgId: string;
let customerId: string;
let otherOrgId: string;
let otherCustomerId: string;
let writeToken: string;
let readToken: string;

async function mkOrg(name: string, vat: string, tag: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "44/444/44444" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  const prefix = `D18D7${tag}-${org.id.slice(-6)}-`;
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId: org.id, docType: "INVOICE", year: 0 } },
    create: { orgId: org.id, docType: "INVOICE", year: 0, currentValue: 0, prefix, pattern: "{PREFIX}{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId: org.id, docType: "INVOICE", year: { not: 0 } }, data: { isActive: false } });
  const c = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: c.id };
}

const draft = (org: string, cust: string) =>
  createDraftInvoice(
    org,
    createInvoiceSchema.parse({
      customerId: cust,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: NOW,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
const finalized = async (org: string, cust: string) => finalizeInvoice((await draft(org, cust)).id, { now: NOW });

function post(b: unknown, opts: { token?: string; key?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${opts.token ?? writeToken}` });
  if (opts.key) headers.set("idempotency-key", opts.key);
  return BulkCancelPost(new Request("http://localhost/api/v1/Invoice/bulk-cancel", { method: "POST", headers, body: JSON.stringify(b) }));
}

interface Result {
  batchId: string;
  ok: { id: string; number: string | null; creditNoteNumber: string | null }[];
  failed: { id: string; number: string | null; code: string; message: string }[];
}

beforeAll(async () => {
  ({ orgId, customerId } = await mkOrg("Sammel-API GmbH", "DE777888001", "A"));
  ({ orgId: otherOrgId, customerId: otherCustomerId } = await mkOrg("Fremd-API GmbH", "DE777888002", "B"));
  orgStore.id = orgId;
  writeToken = (await createApiKey(orgId, { name: "Storno-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "Storno-Read", scopes: ["read"] })).token;
  // Stornobelege tragen die Systemzeit; ohne festes Datum kollidierten Belegnummern anderer Testdateien.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => resetRateLimits());

describe("POST /api/v1/Invoice/bulk-cancel", () => {
  it("storniert je Beleg, meldet Entwurf/fremd/unbekannt, ChangeLog mit Akteur und Batch", async () => {
    const a = await finalized(orgId, customerId);
    const b = await finalized(orgId, customerId);
    const c = await draft(orgId, customerId);
    const d = await finalized(otherOrgId, otherCustomerId);
    const res = await post({ ids: [a.id, b.id, c.id, d.id, "erfunden"], reason: "Doppelt" });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Result };
    expect(data.ok.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(data.ok.every((o) => o.creditNoteNumber)).toBe(true);
    expect(data.failed.map((f) => [f.id, f.code])).toEqual([
      [c.id, "NOT_CANCELLABLE"],
      [d.id, "NOT_FOUND"],
      ["erfunden", "NOT_FOUND"],
    ]);
    const nf = data.failed.filter((f) => f.code === "NOT_FOUND");
    expect(nf.every((f) => f.number === null)).toBe(true);
    expect(nf[0].message).toBe(nf[1].message);
    const dAfter = await dbInternal.invoice.findUniqueOrThrow({ where: { id: d.id }, select: { status: true } });
    expect(dAfter.status).toBe("FINALIZED");
    for (const o of data.ok) {
      const logs = await dbInternal.changeLog.findMany({ where: { orgId, entityId: o.id, action: "CANCEL" }, select: { actor: true, diffJson: true } });
      expect(logs).toHaveLength(1);
      expect(logs[0].actor).toBe("api:storno-write");
      expect((JSON.parse(logs[0].diffJson ?? "{}") as { batch?: string }).batch).toBe(data.batchId);
    }
    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);
  });

  it("validiert: 51 Ids und fehlender Grund -> 400", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    expect((await post({ ids, reason: "x" })).status).toBe(400);
    expect((await post({ ids: ["a"] })).status).toBe(400);
  });

  it("Schluessel ohne write -> 403", async () => {
    expect((await post({ ids: ["a"], reason: "x" }, { token: readToken })).status).toBe(403);
  });

  it("11. Aufruf je Minute -> 429", async () => {
    for (let i = 0; i < 10; i++) expect((await post({ ids: ["x"], reason: "r" })).status).toBe(200);
    expect((await post({ ids: ["x"], reason: "r" })).status).toBe(429);
  });

  it("GET /Invoice/<id> bleibt erreichbar (Routing)", async () => {
    const a = await finalized(orgId, customerId);
    const res = await InvoiceGet(
      new Request(`http://localhost/api/v1/Invoice/${a.id}`, { headers: { authorization: `Bearer ${readToken}` } }),
      { params: Promise.resolve({ id: a.id }) },
    );
    expect(res.status).toBe(200);
  });

  it("Idempotency-Key: Wiederholung liefert dieselbe Antwort, keine weitere Gutschrift", async () => {
    const a = await finalized(orgId, customerId);
    const key = `d18d7-${Date.now()}`;
    const r1 = await post({ ids: [a.id], reason: "Einmal" }, { key });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { data: Result };
    // Die Systemzeit ist auf 2193 gefaelscht, createdAt kommt aus der DB (echte Zeit): sonst gilt der Key als abgelaufen.
    await dbInternal.apiIdempotency.updateMany({ where: { orgId, key }, data: { createdAt: NOW } });
    const r2 = await post({ ids: [a.id], reason: "Einmal" }, { key });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { data: Result }).data).toEqual(j1.data);
    const credits = await dbInternal.changeLog.count({ where: { orgId, entityId: a.id, action: "CANCEL" } });
    expect(credits).toBe(1);
  });
});

describe("MCP cancel_invoices", () => {
  interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }
  const call = (args: Record<string, unknown>) => {
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<ToolResult> }> })._registeredTools;
    return tools["cancel_invoices"].handler(args);
  };

  it("loest Nummer und Id auf, unbekannte Nummer wird NOT_FOUND, Rest laeuft", async () => {
    const a = await finalized(orgId, customerId);
    const b = await finalized(orgId, customerId);
    const res = await call({ invoices: [a.number as string, b.id, "XX-gibt-es-nicht"], reason: "MCP-Storno" });
    expect(res.isError, res.content[0].text).toBeFalsy();
    const out = JSON.parse(res.content[0].text) as Result;
    expect(out.ok.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].code).toBe("NOT_FOUND");
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entityId: a.id, action: "CANCEL" }, select: { actor: true } });
    expect(log.actor).toBe("mcp");
  });
});
