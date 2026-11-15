/**
 * REST und MCP der Belegpruefungen: Umsatzgrenzen-Auswertung, Einstellungen (Teil-Update, Setzen),
 * Verzugshinweis am Beleg und Hinweise beim Festschreiben. Testjahr 2232 (Belegnummern-Praefix je Org).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { kuThreshold } from "@/domain/reporting/ku";
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createInvoiceSchema } from "@/schemas";
import { server } from "@/mcp/server";
import { GET as KuGet } from "@/app/api/v1/Report/smallBusiness/route";
import { PATCH as SettingsPatch, GET as SettingsGet } from "@/app/api/v1/Settings/route";
import { POST as InvoicePost } from "@/app/api/v1/Invoice/route";
import { GET as InvoiceGet, PATCH as InvoicePatch } from "@/app/api/v1/Invoice/[id]/route";
import { POST as FinalizePost } from "@/app/api/v1/Invoice/[id]/finalize/route";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: { safeParseAsync: (d: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: { message: string } }> };
}
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  if (tool.inputSchema) {
    const parsed = await tool.inputSchema.safeParseAsync(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Validierung fehlgeschlagen: ${parsed.error.message}` }], isError: true };
    return tool.handler(parsed.data as Record<string, unknown>);
  }
  return tool.handler(args);
}
const text = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");

const NOW = new Date("2232-05-10T10:00:00.000Z");
let orgId: string;
let otherOrgId: string;
let customerId: string;
let euCustomerId: string;
let adminToken: string;
let writeToken: string;
let readToken: string;

function call<T>(handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<T>, url: string, init: { method?: string; token?: string; body?: unknown; id?: string } = {}) {
  const headers = new Headers({ authorization: `Bearer ${init.token ?? adminToken}` });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return handler(new Request(url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), { params: Promise.resolve({ id: init.id ?? "" }) });
}

async function mkOrg(name: string, tag: string, scheme: "REGULAR" | "KLEINUNTERNEHMER") {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: `DE2232${tag}`, taxNumber: `22/232/0000${tag}`, defaultTaxScheme: scheme },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await saveDocumentSettings(org.id, { viesCheckEnabled: false });
  await updateNumberRange(org.id, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ:5}", prefix: `PP${tag}R-`, seqPadding: 5, yearlyReset: false, nextValue: 1 }, "system", NOW);
  return org.id;
}

const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" };

beforeAll(async () => {
  orgId = await mkOrg("Pruefungen Api GmbH", "1", "KLEINUNTERNEHMER");
  otherOrgId = await mkOrg("Pruefungen Fremd GmbH", "2", "KLEINUNTERNEHMER");
  orgStore.id = orgId;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", type: "CONSUMER", email: "kunde@example.org" } })).id;
  euCustomerId = (await dbInternal.customer.create({ data: { orgId, name: "EU Kunde", addressLine1: "Ring 1", postalCode: "1010", city: "Wien", countryCode: "AT", type: "BUSINESS", email: "eu@example.org", vatId: "ATU12345678" } })).id;
  const otherCustomer = await dbInternal.customer.create({ data: { orgId: otherOrgId, name: "Fremdkunde", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE", type: "BUSINESS" } });
  // Fremde Org mit hohem Umsatz: darf in der Auswertung der eigenen Org nie auftauchen.
  const big = await createDraftInvoice(
    otherOrgId,
    createInvoiceSchema.parse({
      customerId: otherCustomer.id, type: "INVOICE", taxScheme: "KLEINUNTERNEHMER", currency: "EUR", issueDate: NOW, deliveryDate: NOW,
      notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 5_000_000, taxRate: 0, taxCategory: "Z", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  await finalizeInvoice(big.id, { now: NOW });
  adminToken = (await createApiKey(orgId, { name: "PP-Admin", scopes: ["read", "write", "admin"] })).token;
  writeToken = (await createApiKey(orgId, { name: "PP-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "PP-Read", scopes: ["read"] })).token;
});

beforeEach(() => {
  resetRateLimits();
});

describe("Umsatzgrenzen: REST und MCP", () => {
  it("read-Schluessel, Jahr-Parameter, fremde Org nie enthalten", async () => {
    const res = await call(KuGet, "http://x/api/v1/Report/smallBusiness?year=2232", { token: readToken });
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.year).toBe(2232);
    expect(data.applies).toBe(true);
    expect(data.current.invoicedCents).toBe(0);
    expect(data.current.documentCount).toBe(0);
    expect(data).toEqual(JSON.parse(JSON.stringify(await kuThreshold(orgId, 2232))));
  });

  it("400 bei ungueltigem Jahr, 401 ohne Schluessel", async () => {
    expect((await call(KuGet, "http://x/api/v1/Report/smallBusiness?year=abc")).status).toBe(400);
    expect((await call(KuGet, "http://x/api/v1/Report/smallBusiness?year=1999")).status).toBe(400);
    expect((await KuGet(new Request("http://x/api/v1/Report/smallBusiness"), { params: Promise.resolve({}) } as never)).status).toBe(401);
  });

  it("MCP liefert dasselbe Objekt wie REST", async () => {
    const rest = (await (await call(KuGet, "http://x/api/v1/Report/smallBusiness?year=2232")).json()).data;
    const r = await callTool("get_small_business_threshold", { year: 2232 });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual(rest);
  });
});

describe("Einstellungen per REST und MCP", () => {
  it("PATCH nur mit invoiceDueDays laesst die vier neuen Felder unveraendert", async () => {
    await saveDocumentSettings(orgId, { ...(await loadDocumentSettings(orgId)), kuWarnPercent: 70, kuBusinessStartYear: 2031, kuExternalRevenue: { "2030": 4_500_000 }, consumerDefaultNotice: true });
    const res = await call(SettingsPatch, "http://x/api/v1/Settings", { method: "PATCH", body: { documents: { invoiceDueDays: 21 } } });
    expect(res.status).toBe(200);
    const s = await loadDocumentSettings(orgId);
    expect(s.invoiceDueDays).toBe(21);
    expect(s).toMatchObject({ kuWarnPercent: 70, kuBusinessStartYear: 2031, kuExternalRevenue: { "2030": 4_500_000 }, consumerDefaultNotice: true });
  });

  it("REST: die vier Felder setzen und lesen; ungueltige Werte -> 400", async () => {
    const body = { documents: { kuWarnPercent: 90, kuBusinessStartYear: 2029, kuExternalRevenue: { "2028": 1_234_500 }, consumerDefaultNotice: false } };
    expect((await call(SettingsPatch, "http://x/api/v1/Settings", { method: "PATCH", body })).status).toBe(200);
    const got = (await (await call(SettingsGet, "http://x/api/v1/Settings")).json()).data.documents;
    expect(got).toMatchObject({ kuWarnPercent: 90, kuBusinessStartYear: 2029, kuExternalRevenue: { "2028": 1_234_500 }, consumerDefaultNotice: false });
    for (const bad of [{ kuWarnPercent: 100 }, { kuExternalRevenue: { "25": 1 } }, { kuExternalRevenue: { "2028": -1 } }, { kuBusinessStartYear: 1999 }]) {
      expect((await call(SettingsPatch, "http://x/api/v1/Settings", { method: "PATCH", body: { documents: bad } })).status).toBe(400);
    }
    expect((await call(SettingsPatch, "http://x/api/v1/Settings", { method: "PATCH", token: writeToken, body })).status).toBe(403);
  });

  it("MCP: die vier Felder setzen, Teil-Update laesst sie stehen", async () => {
    const r = await callTool("update_document_settings", { kuWarnPercent: 75, kuBusinessStartYear: null, kuExternalRevenue: { "2027": 99_900 }, consumerDefaultNotice: true });
    expect(r.isError).toBeFalsy();
    expect(await loadDocumentSettings(orgId)).toMatchObject({ kuWarnPercent: 75, kuBusinessStartYear: null, kuExternalRevenue: { "2027": 99_900 }, consumerDefaultNotice: true });
    expect((await callTool("update_document_settings", { invoiceDueDays: 10 })).isError).toBeFalsy();
    expect(await loadDocumentSettings(orgId)).toMatchObject({ invoiceDueDays: 10, kuWarnPercent: 75, kuExternalRevenue: { "2027": 99_900 }, consumerDefaultNotice: true });
    expect((await callTool("update_document_settings", { kuWarnPercent: 0 })).isError).toBe(true);
  });
});

describe("Verzugshinweis am Beleg", () => {
  it("REST: anlegen mit true, aendern auf false und auf null (automatisch)", async () => {
    const created = await call(InvoicePost, "http://x/api/v1/Invoice", {
      method: "POST", token: writeToken,
      body: { customerId, taxScheme: "REGULAR", issueDate: NOW.toISOString(), deliveryDate: NOW.toISOString(), consumerDefaultNotice: true, lines: [line] },
    });
    expect(created.status).toBe(201);
    const inv = (await created.json()).data as { id: string; consumerDefaultNotice: boolean | null };
    expect(inv.consumerDefaultNotice).toBe(true);
    for (const v of [false, null] as const) {
      const patched = await call(InvoicePatch, `http://x/api/v1/Invoice/x`, { method: "PATCH", token: writeToken, id: inv.id, body: { consumerDefaultNotice: v } });
      expect(patched.status).toBe(200);
      expect((await patched.json()).data.consumerDefaultNotice).toBe(v);
      const got = await call(InvoiceGet, `http://x/api/v1/Invoice/x`, { token: readToken, id: inv.id });
      expect((await got.json()).data.consumerDefaultNotice).toBe(v);
    }
    expect((await call(InvoicePatch, `http://x/api/v1/Invoice/x`, { method: "PATCH", token: writeToken, id: inv.id, body: { consumerDefaultNotice: "ja" } })).status).toBe(400);
  });

  it("MCP: anlegen und aendern", async () => {
    const created = await callTool("create_invoice", { customer: "Kunde AG", deliveryDate: "2232-05-01", consumerDefaultNotice: true, lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 100, taxRatePercent: 19 }] });
    expect(created.isError).toBeFalsy();
    const id = /ID: (\S+)/.exec(text(created))![1]!;
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { consumerDefaultNotice: true } })).consumerDefaultNotice).toBe(true);
    expect((await callTool("update_invoice_draft", { invoice: id, consumerDefaultNotice: false })).isError).toBeFalsy();
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { consumerDefaultNotice: true } })).consumerDefaultNotice).toBe(false);
    expect((await callTool("update_invoice_draft", { invoice: id, consumerDefaultNotice: null })).isError).toBeFalsy();
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { consumerDefaultNotice: true } })).consumerDefaultNotice).toBeNull();
  });
});

describe("Hinweise beim Festschreiben per REST", () => {
  it("Ausstellfrist: Text in warnings, Beleg wird trotzdem festgeschrieben", async () => {
    const d = await createDraftInvoice(
      orgId,
      createInvoiceSchema.parse({
        customerId: euCustomerId, type: "INVOICE", taxScheme: "IG_LIEFERUNG", currency: "EUR", issueDate: NOW, deliveryDate: new Date("2232-02-03T10:00:00.000Z"),
        notes: "Steuerfreie innergemeinschaftliche Lieferung gemäß § 4 Nr. 1b i. V. m. § 6a UStG",
        lines: [{ description: "Ware", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 0, taxCategory: "K", discountPermille: 0, discountCents: 0 }],
      }),
      { now: NOW },
    );
    const res = await call(FinalizePost, "http://x/api/v1/Invoice/x/finalize", { method: "POST", token: writeToken, id: d.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string; issueDeadline: string | null }; warnings: string[] };
    expect(json.data.status).toBe("FINALIZED");
    expect(json.data.issueDeadline).toBe("2232-03-15");
    expect(json.warnings.some((w) => w.includes("Ausstellfrist überschritten") && w.includes("§ 14a Abs. 1, 3 UStG"))).toBe(true);
  });

  it("Umsatzgrenze: Hinweis mit Paragraf und Orientierungssatz, Schema bleibt Kleinunternehmer", async () => {
    const mk = (cents: number) =>
      createDraftInvoice(
        orgId,
        createInvoiceSchema.parse({
          customerId, type: "INVOICE", taxScheme: "KLEINUNTERNEHMER", currency: "EUR", issueDate: NOW, deliveryDate: NOW,
          notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
          lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: cents, taxRate: 0, taxCategory: "Z", discountPermille: 0, discountCents: 0 }],
        }),
        { now: NOW },
      );
    await finalizeInvoice((await mk(10_100_000)).id, { now: NOW });
    const d = await mk(5_000);
    const res = await call(FinalizePost, "http://x/api/v1/Invoice/x/finalize", { method: "POST", token: writeToken, id: d.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { taxScheme: string }; warnings: string[] };
    expect(json.data.taxScheme).toBe("KLEINUNTERNEHMER");
    const w = json.warnings.find((x) => x.includes("§ 19 Abs. 1 UStG"));
    expect(w).toBeDefined();
    expect(w!.endsWith("das Steuerschema wird nie automatisch umgestellt.")).toBe(true);
  });
});
