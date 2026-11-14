/**
 * Phase 18e Task 7: Boundaries fuer Glaeubiger-ID, Lastschriftmandat und Kartenfelder
 * (Server-Action, REST v1, MCP). Testjahr 2182, eigene Organisation.
 * Datenschutz: volle IBAN nie in Antworten, nie mehr als 4 Kartenziffern in Antwort/Protokoll/Fehlertext.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveApiSettings } from "@/domain/api-log/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createInvoiceSchema } from "@/schemas";
import { saveOrganization } from "@/app/actions/masterdata";
import { server } from "@/mcp/server";

import { POST as ContactCreate } from "@/app/api/v1/Contact/route";
import { GET as ContactGet, PATCH as ContactUpdate } from "@/app/api/v1/Contact/[id]/route";
import { POST as InvoiceCreate } from "@/app/api/v1/Invoice/route";
import { GET as InvoiceGet } from "@/app/api/v1/Invoice/[id]/route";

const IBAN = "DE02120300000000202051";
const NOW = new Date("2182-03-02T10:00:00.000Z");
const PAN = "4111111111111111";

let orgId: string;
let token: string;
let customerId: string;
let cardId: string;
let sepaId: string;

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

function req(url: string, opts: { method?: string; body?: unknown } = {}) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

const baseContact = { addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" };
const line = { description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Boundary GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE218200001", taxNumber: "21/820/00001", iban: IBAN, bic: "BYLADEM1001", sepaCreditorId: "DE98ZZZ09999999999" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  cardId = (await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code: "CREDIT_CARD" }, select: { id: true } })).id;
  sepaId = (await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code: "SEPA" }, select: { id: true } })).id;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Karten Kunde", ...baseContact, type: "BUSINESS", email: "k@example.org" } })).id;
  token = (await createApiKey(orgId, { name: "Boundary-Key", scopes: ["read", "write", "admin"] })).token;
  await saveApiSettings(orgId, { logRequests: true, logBodies: true });
});

beforeEach(() => resetRateLimits());

describe("REST Contact: Lastschriftmandat", () => {
  let id: string;

  it("POST mit Mandat -> 201, IBAN nur maskiert", async () => {
    const res = await ContactCreate(
      req("http://x/api/v1/Contact", {
        method: "POST",
        body: { ...baseContact, name: "Mandat A", sepaMandateReference: "MANDAT-2182-001", sepaMandateSignedAt: "2182-01-15", sepaDebitIban: "DE02 1203 0000 0000 2020 51", sepaDebitAccountName: "Erika Beispiel" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.text();
    expect(body).not.toContain(IBAN);
    expect(body).not.toContain("1203 0000");
    const j = JSON.parse(body);
    expect(j.data.sepaDebitIbanMasked).toBe("DE02 **** 2051");
    expect(j.data.sepaMandateReference).toBe("MANDAT-2182-001");
    expect(j.data.sepaMandateSignedAt).toBe("2182-01-15");
    expect(j.data).not.toHaveProperty("sepaDebitIban");
    id = j.data.id;
    const stored = await dbInternal.customer.findUniqueOrThrow({ where: { id }, select: { sepaDebitIban: true } });
    expect(stored.sepaDebitIban).toBe(IBAN);
  });

  it("GET gibt die IBAN ebenfalls nur maskiert aus", async () => {
    const res = await ContactGet(req(`http://x/api/v1/Contact/${id}`), idCtx(id));
    const body = await res.text();
    expect(body).not.toContain(IBAN);
    expect(JSON.parse(body).data.sepaDebitIbanMasked).toBe("DE02 **** 2051");
  });

  it("POST nur mit Mandatsreferenz -> 400 (Pfad sepaDebitIban)", async () => {
    const res = await ContactCreate(req("http://x/api/v1/Contact", { method: "POST", body: { ...baseContact, name: "Mandat B", sepaMandateReference: "MANDAT-2182-002" } }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.details.issues.some((i: { path: string[] }) => i.path.includes("sepaDebitIban"))).toBe(true);
  });

  it("PATCH nur sepaDebitIban bei vorhandener Referenz -> 200", async () => {
    const res = await ContactUpdate(req(`http://x/api/v1/Contact/${id}`, { method: "PATCH", body: { sepaDebitIban: "DE89370400440532013000" } }), idCtx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).data.sepaDebitIbanMasked).toBe("DE89 **** 3000");
  });

  it("PATCH nur Referenz leeren bei gesetzter IBAN -> 400, Meldung ohne Werte", async () => {
    const res = await ContactUpdate(req(`http://x/api/v1/Contact/${id}`, { method: "PATCH", body: { sepaMandateReference: "" } }), idCtx(id));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("DE89370400440532013000");
    const stored = await dbInternal.customer.findUniqueOrThrow({ where: { id }, select: { sepaMandateReference: true } });
    expect(stored.sepaMandateReference).toBe("MANDAT-2182-001");
  });

  it("PATCH Referenz und IBAN leer -> beide null", async () => {
    const res = await ContactUpdate(req(`http://x/api/v1/Contact/${id}`, { method: "PATCH", body: { sepaMandateReference: "", sepaDebitIban: "" } }), idCtx(id));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data.sepaMandateReference).toBeNull();
    expect(j.data.sepaDebitIbanMasked).toBeNull();
    const stored = await dbInternal.customer.findUniqueOrThrow({ where: { id }, select: { sepaMandateReference: true, sepaDebitIban: true } });
    expect(stored).toEqual({ sepaMandateReference: null, sepaDebitIban: null });
  });
});

describe("saveOrganization: Glaeubiger-ID", () => {
  function form(creditor?: string): FormData {
    const fd = new FormData();
    fd.set("legalName", "Boundary GmbH");
    fd.set("addressLine1", "Teststr. 1");
    fd.set("postalCode", "10115");
    fd.set("city", "Berlin");
    fd.set("country", "DE");
    fd.set("email", "firma@example.org");
    fd.set("vatId", "DE218200001");
    fd.set("defaultTaxScheme", "REGULAR");
    if (creditor !== undefined) fd.set("sepaCreditorId", creditor);
    return fd;
  }
  function useOwnOrg() {
    return vi.spyOn(dbInternal.organization, "findFirst").mockResolvedValue(
      (await_org ?? null) as never,
    );
  }
  let await_org: unknown;

  beforeAll(async () => {
    await_org = await dbInternal.organization.findUniqueOrThrow({ where: { id: orgId } });
  });

  it("falsche Pruefziffer -> Fehlermeldung, nichts gespeichert", async () => {
    const spy = useOwnOrg();
    const res = await saveOrganization({ ok: false }, form("DE97ZZZ09999999999"));
    spy.mockRestore();
    expect(res).toEqual({ ok: false, error: "Ungültige Gläubiger-ID (Format oder Prüfziffer)." });
  });

  it("mit Leerzeichen -> normalisiert gespeichert; leer -> null", async () => {
    const spy = useOwnOrg();
    await expect(saveOrganization({ ok: false }, form("DE98 ZZZ 0999 9999 999"))).rejects.toThrow("NEXT_REDIRECT");
    expect((await dbInternal.organization.findUniqueOrThrow({ where: { id: orgId }, select: { sepaCreditorId: true } })).sepaCreditorId).toBe("DE98ZZZ09999999999");
    await expect(saveOrganization({ ok: false }, form(""))).rejects.toThrow("NEXT_REDIRECT");
    spy.mockRestore();
    expect((await dbInternal.organization.findUniqueOrThrow({ where: { id: orgId }, select: { sepaCreditorId: true } })).sepaCreditorId).toBeNull();
    await dbInternal.organization.update({ where: { id: orgId }, data: { sepaCreditorId: "DE98ZZZ09999999999" } });
  });
});

describe("MCP: setup_company, Kunde", () => {
  it("setup_company mit sepaCreditorId speichert, ohne Schluessel bleibt der Bestand", async () => {
    const base = { legalName: "Boundary GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE218200001" };
    const res = await callTool("setup_company", { ...base, country: "DE", smallBusiness: false, defaultTaxScheme: "REGULAR", sepaCreditorId: "DE09ZZZ00000000001" });
    expect(res.isError).toBeFalsy();
    expect((await dbInternal.organization.findUniqueOrThrow({ where: { id: orgId }, select: { sepaCreditorId: true } })).sepaCreditorId).toBe("DE09ZZZ00000000001");
    const again = await callTool("setup_company", { ...base, country: "DE", smallBusiness: false, defaultTaxScheme: "REGULAR" });
    expect(again.isError).toBeFalsy();
    expect((await dbInternal.organization.findUniqueOrThrow({ where: { id: orgId }, select: { sepaCreditorId: true } })).sepaCreditorId).toBe("DE09ZZZ00000000001");
    await dbInternal.organization.update({ where: { id: orgId }, data: { sepaCreditorId: "DE98ZZZ09999999999" } });
  });

  it("upsert_customer / update_customer speichern das Mandat, Antworttexte ohne volle IBAN", async () => {
    const up = await callTool("upsert_customer", { name: "MCP Mandat", ...baseContact, sepaMandateReference: "MANDAT-2182-010", sepaDebitIban: IBAN });
    expect(up.isError).toBeFalsy();
    expect(text(up)).not.toContain(IBAN);
    const row = await dbInternal.customer.findFirstOrThrow({ where: { orgId, name: "MCP Mandat" }, select: { sepaMandateReference: true, sepaDebitIban: true } });
    expect(row).toEqual({ sepaMandateReference: "MANDAT-2182-010", sepaDebitIban: IBAN });

    const upd = await callTool("update_customer", { customer: "MCP Mandat", sepaDebitAccountName: "Erika Beispiel" });
    expect(upd.isError).toBeFalsy();
    expect(text(upd)).not.toContain(IBAN);

    const bad = await callTool("update_customer", { customer: "MCP Mandat", sepaMandateReference: "" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).not.toContain(IBAN);
  });
});

describe("REST Invoice: Kartenfelder und Lastschrift-Ausgabe", () => {
  it("POST mit Kartenfeldern -> nur letzte 4 Ziffern in der Antwort", async () => {
    const res = await InvoiceCreate(
      req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, paymentMethodId: cardId, cardPanTruncated: "**** 1234", cardNetwork: "VISA", cardHolderName: "Erika Beispiel", lines: [line] } }),
    );
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.data.cardPanTruncated).toBe("1234");
    expect(j.data.cardNetwork).toBe("VISA");
    expect(j.data.directDebit).toBeNull();
  });

  it("volle Kartennummer -> 400, weder Antwort noch Protokoll enthalten sie", async () => {
    await dbInternal.apiRequestLog.deleteMany({ where: { orgId } });
    const res = await InvoiceCreate(req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, paymentMethodId: cardId, cardPanTruncated: PAN, lines: [line] } }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(PAN);
    let rows = await dbInternal.apiRequestLog.findMany({ where: { orgId }, select: { requestBody: true, responseBody: true, path: true } });
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await dbInternal.apiRequestLog.findMany({ where: { orgId }, select: { requestBody: true, responseBody: true, path: true } });
    }
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.requestBody ?? "").not.toContain(PAN);
      expect(r.responseBody ?? "").not.toContain(PAN);
    }
    expect(rows.some((r) => (r.requestBody ?? "").includes("[redaktiert]"))).toBe(true);
  });

  it("GET einer festgeschriebenen Lastschriftrechnung -> directDebit mit maskierter IBAN", async () => {
    const mandate = await dbInternal.customer.create({
      data: { orgId, name: "Lastschrift Kunde", ...baseContact, type: "BUSINESS", email: "l@example.org", sepaMandateReference: "MANDAT-2182-020", sepaMandateSignedAt: new Date("2182-01-15T00:00:00.000Z"), sepaDebitIban: IBAN },
    });
    const d = await createDraftInvoice(
      orgId,
      createInvoiceSchema.parse({ customerId: mandate.id, type: "INVOICE", taxScheme: "REGULAR", issueDate: NOW, deliveryDate: NOW, paymentMethodId: sepaId, lines: [line] }),
      { now: NOW },
    );
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const res = await InvoiceGet(req(`http://x/api/v1/Invoice/${fin.id}`), idCtx(fin.id));
    const body = await res.text();
    expect(body).not.toContain(IBAN);
    expect(JSON.parse(body).data.directDebit).toEqual({ mandateReference: "MANDAT-2182-020", creditorId: "DE98ZZZ09999999999", debtorIbanMasked: "DE02 **** 2051" });
  });

  it("Org-Scope: Zahlungsmethode einer fremden Organisation wird nicht uebernommen", async () => {
    const other = await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "X 1", postalCode: "10115", city: "Berlin" } });
    await ensureOrgMasterdata(dbInternal, other.id);
    const foreign = await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId: other.id, code: "CREDIT_CARD" }, select: { id: true } });
    const res = await InvoiceCreate(req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, paymentMethodId: foreign.id, cardPanTruncated: "1234", lines: [line] } }));
    expect(res.status).toBe(404);
  });
});

describe("MCP: Kartenfelder", () => {
  it("create_invoice und update_invoice_draft speichern Kartenfelder", async () => {
    const created = await callTool("create_invoice", {
      customer: "Karten Kunde",
      lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 100 }],
      paymentMethod: "CREDIT_CARD",
      cardPanTruncated: "**** 4321",
      cardNetwork: "MASTERCARD",
    });
    expect(created.isError).toBeFalsy();
    const id = /ID: (\S+)/.exec(text(created))?.[1] ?? "";
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { cardPanTruncated: true, cardNetwork: true } });
    expect(row).toEqual({ cardPanTruncated: "4321", cardNetwork: "MASTERCARD" });

    const upd = await callTool("update_invoice_draft", { invoice: id, cardHolderName: "Erika Beispiel", cardPanTruncated: "9876" });
    expect(upd.isError).toBeFalsy();
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { cardPanTruncated: true, cardHolderName: true } });
    expect(after).toEqual({ cardPanTruncated: "9876", cardHolderName: "Erika Beispiel" });
  });

  it("PAN mit 16 Ziffern -> Fehlertext ohne die Ziffern", async () => {
    const bad = await callTool("create_invoice", {
      customer: "Karten Kunde",
      lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 100 }],
      paymentMethod: "CREDIT_CARD",
      cardPanTruncated: PAN,
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).not.toContain(PAN);
    expect(text(bad)).not.toMatch(/\d{5,}/);
  });
});
