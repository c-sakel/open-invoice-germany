/**
 * Phase 16b, Task 9 — MCP-Tools get_exchange_rate / set_exchange_rate / refresh_exchange_rates
 * (dieselben Zod-Schemas wie REST) und create_invoice mit Belegsprache. Eigenes Testjahr 2111
 * (Invoice.number ist global @unique; Kurse sind instanzweit und liegen im Jahr 2111).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { server } from "@/mcp/server";
import { GET as RateGet } from "@/app/api/v1/ExchangeRate/route";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface ZodLikeSchema {
  safeParseAsync: (data: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: { message: string } }>;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: ZodLikeSchema;
}
/** Ruft ein Tool wie ein echter Client auf — inkl. Schema-Validierung des SDK. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  if (tool.inputSchema) {
    const parsed = await tool.inputSchema.safeParseAsync(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Validierung fehlgeschlagen: ${parsed.error.message}` }], isError: true };
    return tool.handler(parsed.data as Record<string, unknown>);
  }
  return tool.handler(args);
}
const text = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");

const NOW = new Date("2111-03-20T10:00:00.000Z");
let orgId: string;
let token: string;

async function cleanRates(): Promise<void> {
  await dbInternal.exchangeRate.deleteMany({ where: { rateDate: { gte: new Date("2111-01-01"), lt: new Date("2112-01-01") } } });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "MCP-Kurs GmbH", addressLine1: "Kursweg 3", postalCode: "10115", city: "Berlin", vatId: "DE211121112", taxNumber: "21/111/00000" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, fxRateSource: "BMF_MONTHLY" }, update: { fxRateSource: "BMF_MONTHLY" } });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2111 } },
    create: { orgId, docType: "INVOICE", year: 2111, currentValue: 0, prefix: "MFX-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: {},
  });
  await dbInternal.customer.create({
    data: { orgId, name: "Dublin Ltd", addressLine1: "1 Main Street", postalCode: "D01", city: "Dublin", countryCode: "IE", vatId: "IE6388047V", type: "BUSINESS", language: "en" },
  });
  token = (await createApiKey(orgId, { name: "MCP-Kurs", scopes: ["read", "write", "admin"] })).token;
  await cleanRates();
});

afterAll(async () => {
  await cleanRates();
  await dbInternal.$disconnect();
});

describe("set_exchange_rate / get_exchange_rate", () => {
  it("rate \"0\" -> Validierungsfehler wie REST (400)", async () => {
    const res = await callTool("set_exchange_rate", { source: "ECB", currency: "USD", rateDate: "2111-03-12", rate: "0" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Validierung fehlgeschlagen/);
  });

  it("Kurs pflegen, abrufen, gleiches Ergebnis wie REST", async () => {
    const set = await callTool("set_exchange_rate", { source: "MONTHLY", currency: "USD", rateDate: "2111-03-01", rate: "1,1214", note: "BMF" });
    expect(set.isError).toBeUndefined();
    expect(text(set)).toContain('"origin":"MANUAL"');

    const get = await callTool("get_exchange_rate", { currency: "USD", date: "2111-03-12" });
    expect(get.isError).toBeUndefined();
    const mcp = JSON.parse(text(get)) as unknown;

    resetRateLimits();
    const rest = await RateGet(new Request("http://x/api/v1/ExchangeRate?currency=USD&date=2111-03-12", { headers: { authorization: `Bearer ${token}` } }));
    expect(rest.status).toBe(200);
    expect((await rest.json()).data).toEqual(mcp);
    expect(mcp).toEqual({ currency: "USD", rate: "1.1214", rateDate: "2111-03-01", source: "BMF_MONTHLY" });
  });

  it("ohne Kurs: Fehler, ungueltige Waehrung: Validierungsfehler", async () => {
    const none = await callTool("get_exchange_rate", { currency: "CHF", date: "2111-03-12" });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain("Kein Kurs");
    const bad = await callTool("get_exchange_rate", { currency: "US", date: "2111-03-12" });
    expect(bad.isError).toBe(true);
  });
});

describe("refresh_exchange_rates", () => {
  it("FX_AUTO_FETCH=0 -> Fehlermeldung, kein Netz", async () => {
    const res = await callTool("refresh_exchange_rates");
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("FX_AUTO_FETCH=0");
  });
});

describe("create_invoice mit Belegsprache", () => {
  it("language en + REVERSE_CHARGE: englischer Pflichthinweis, danach festschreibbar", async () => {
    const res = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      taxScheme: "REVERSE_CHARGE",
      language: "en",
      deliveryDate: "2111-03-01",
      paymentTerms: "Payable within 14 days.",
      lines: [{ description: "Consulting", quantity: 1, unitPriceEuro: 100, unit: "HUR" }],
    });
    expect(res.isError).toBeUndefined();
    const id = /ID: (\S+)/.exec(text(res))?.[1];
    expect(id).toBeTruthy();
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: id! }, select: { language: true, notes: true } });
    expect(inv.language).toBe("en");
    expect(inv.notes).toBe("Reverse charge (Steuerschuldnerschaft des Leistungsempfängers)");
    expect(inv.notes).not.toBe("Steuerschuldnerschaft des Leistungsempfängers");

    const fin = await finalizeInvoice(id!, { now: NOW });
    expect(fin.number).toMatch(/^MFX-2111-/);
  });

  it("ohne language: Kundensprache en wird uebernommen, Hinweis englisch", async () => {
    const res = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      taxScheme: "REVERSE_CHARGE",
      deliveryDate: "2111-03-02",
      lines: [{ description: "Consulting", quantity: 1, unitPriceEuro: 50, unit: "HUR" }],
    });
    const id = /ID: (\S+)/.exec(text(res))?.[1];
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: id! }, select: { language: true, notes: true } });
    expect(inv.language).toBe("en");
    expect(inv.notes).toContain("Reverse charge");
  });

  it("language de uebersteuert die Kundensprache: deutscher Hinweis", async () => {
    const res = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      taxScheme: "REVERSE_CHARGE",
      language: "de",
      deliveryDate: "2111-03-02",
      lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 50, unit: "HUR" }],
    });
    const id = /ID: (\S+)/.exec(text(res))?.[1];
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: id! }, select: { language: true, notes: true } });
    expect(inv.language).toBe("de");
    expect(inv.notes).toBe("Steuerschuldnerschaft des Leistungsempfängers");
  });

  it("fxOverrideRate bei Fremdwaehrung wird am Entwurf gespeichert; bei EUR abgelehnt", async () => {
    const ok = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      currency: "USD",
      fxOverrideRate: "1,25",
      deliveryDate: "2111-03-02",
      lines: [{ description: "Service", quantity: 1, unitPriceEuro: 100, unit: "HUR" }],
    });
    expect(ok.isError).toBeUndefined();
    const id = /ID: (\S+)/.exec(text(ok))?.[1];
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: id! }, select: { fxOverrideMicros: true } });
    expect(inv.fxOverrideMicros).toBe(1_250_000);

    const eur = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      currency: "EUR",
      fxOverrideRate: "1,25",
      deliveryDate: "2111-03-02",
      lines: [{ description: "Service", quantity: 1, unitPriceEuro: 100, unit: "HUR" }],
    });
    expect(eur.isError).toBe(true);
  });
});

describe("update_invoice_draft und create_document", () => {
  it("language und fxOverrideRate am Entwurf aendern", async () => {
    const created = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      currency: "USD",
      language: "de",
      deliveryDate: "2111-03-03",
      lines: [{ description: "Service", quantity: 1, unitPriceEuro: 10, unit: "HUR" }],
    });
    const id = /ID: (\S+)/.exec(text(created))?.[1];
    const upd = await callTool("update_invoice_draft", { invoice: id, language: "en", fxOverrideRate: "1,3" });
    expect(upd.isError).toBeUndefined();
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: id! }, select: { language: true, fxOverrideMicros: true } });
    expect(inv).toEqual({ language: "en", fxOverrideMicros: 1_300_000 });
    const clear = await callTool("update_invoice_draft", { invoice: id, fxOverrideRate: null });
    expect(clear.isError).toBeUndefined();
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id: id! }, select: { fxOverrideMicros: true } })).fxOverrideMicros).toBeNull();
  });

  it("create_document mit language", async () => {
    const res = await callTool("create_document", {
      kind: "ANGEBOT",
      customer: "Dublin Ltd",
      language: "de",
      lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 100 }],
    });
    expect(res.isError).toBeUndefined();
    const q = await dbInternal.quote.findFirstOrThrow({ where: { orgId }, orderBy: { createdAt: "desc" }, select: { language: true } });
    expect(q.language).toBe("de");
  });
});

describe("update_document_settings: fxRateSource", () => {
  it("ECB_DAILY nur mit fxEcbConfirmed: ohne Bestaetigung Validierungsfehler, Quelle unveraendert", async () => {
    const res = await callTool("update_document_settings", { fxRateSource: "ECB_DAILY" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Gestattung des Finanzamts");
    const stored = JSON.parse(text(await callTool("get_settings", { area: "documents" }))) as { fxRateSource: string };
    expect(stored.fxRateSource).toBe("BMF_MONTHLY");
  });

  it("mit Bestaetigung gesetzt; spaetere Teil-Updates brauchen sie nicht erneut; Rueckwechsel frei", async () => {
    const ok = await callTool("update_document_settings", { fxRateSource: "ECB_DAILY", fxEcbConfirmed: true });
    expect(ok.isError).toBeUndefined();
    expect(text(ok)).not.toContain("fxEcbConfirmed");
    expect(JSON.parse(text(await callTool("get_settings", { area: "documents" }))).fxRateSource).toBe("ECB_DAILY");
    expect((await callTool("update_document_settings", { invoiceDueDays: 21 })).isError).toBeUndefined();
    expect(JSON.parse(text(await callTool("get_settings", { area: "documents" }))).fxRateSource).toBe("ECB_DAILY");
    expect((await callTool("update_document_settings", { fxRateSource: "BMF_MONTHLY" })).isError).toBeUndefined();
    expect((await callTool("update_document_settings", { fxRateSource: "XYZ" })).isError).toBe(true);
  });
});

describe("update_invoice_draft: Sprachwechsel und Pflichthinweis", () => {
  const EN = "Reverse charge (Steuerschuldnerschaft des Leistungsempfängers)";
  const DE = "Steuerschuldnerschaft des Leistungsempfängers";
  async function rcDraft(language: string, notes?: string): Promise<string> {
    const res = await callTool("create_invoice", {
      customer: "Dublin Ltd",
      taxScheme: "REVERSE_CHARGE",
      language,
      notes,
      deliveryDate: "2111-03-05",
      lines: [{ description: "Consulting", quantity: 1, unitPriceEuro: 10, unit: "HUR" }],
    });
    return /ID: (\S+)/.exec(text(res))![1]!;
  }
  const notesOf = async (id: string) => (await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { notes: true } })).notes;

  it("en -> de ersetzt den Hinweis, de -> en zurueck, nie doppelt", async () => {
    const id = await rcDraft("en");
    expect(await notesOf(id)).toBe(EN);
    expect((await callTool("update_invoice_draft", { invoice: id, language: "de" })).isError).toBeUndefined();
    expect(await notesOf(id)).toBe(DE);
    await callTool("update_invoice_draft", { invoice: id, language: "en" });
    expect(await notesOf(id)).toBe(EN);
    await callTool("update_invoice_draft", { invoice: id, language: "en" });
    expect(await notesOf(id)).toBe(EN);
  });

  it("Hinweis mit Nutzertext: nur der Hinweis wechselt, Nutzertext bleibt", async () => {
    const id = await rcDraft("en", "Bitte Rechnungsnummer angeben.");
    expect(await notesOf(id)).toBe(`${EN} — Bitte Rechnungsnummer angeben.`);
    await callTool("update_invoice_draft", { invoice: id, language: "de" });
    expect(await notesOf(id)).toBe(`${DE} — Bitte Rechnungsnummer angeben.`);
  });

  it("fehlender Hinweis wird in der neuen Sprache gesetzt; Nutzertext ohne Hinweis bekommt ihn vorangestellt", async () => {
    const id = await rcDraft("de");
    await callTool("update_invoice_draft", { invoice: id, notes: "Nur Text" });
    expect(await notesOf(id)).toBe("Nur Text");
    await callTool("update_invoice_draft", { invoice: id, language: "en" });
    expect(await notesOf(id)).toBe(`${EN} — Nur Text`);
  });

  it("Sprachwechsel mit Schema ohne Hinweis (REGULAR) laesst die Notiz unveraendert", async () => {
    const res = await callTool("create_invoice", { customer: "Dublin Ltd", deliveryDate: "2111-03-05", notes: "Danke", lines: [{ description: "X", quantity: 1, unitPriceEuro: 1, unit: "HUR" }] });
    const id = /ID: (\S+)/.exec(text(res))![1]!;
    await callTool("update_invoice_draft", { invoice: id, language: "de" });
    expect(await notesOf(id)).toBe("Danke");
  });
});

describe("update_invoice_draft: fxOverrideRate", () => {
  it("EUR-Entwurf: Kurs abgelehnt, Entwurf unveraendert", async () => {
    const res = await callTool("create_invoice", { customer: "Dublin Ltd", currency: "EUR", deliveryDate: "2111-03-06", lines: [{ description: "X", quantity: 1, unitPriceEuro: 1, unit: "HUR" }] });
    const id = /ID: (\S+)/.exec(text(res))![1]!;
    const upd = await callTool("update_invoice_draft", { invoice: id, fxOverrideRate: "1,25" });
    expect(upd.isError).toBe(true);
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { fxOverrideMicros: true } })).fxOverrideMicros).toBeNull();
  });

  it("ungueltiger Kurs -> Validierungsfehler", async () => {
    const res = await callTool("create_invoice", { customer: "Dublin Ltd", currency: "USD", deliveryDate: "2111-03-06", lines: [{ description: "X", quantity: 1, unitPriceEuro: 1, unit: "HUR" }] });
    const id = /ID: (\S+)/.exec(text(res))![1]!;
    const upd = await callTool("update_invoice_draft", { invoice: id, fxOverrideRate: "abc" });
    expect(upd.isError).toBe(true);
    expect(text(upd)).toContain("Validierung");
    const bad = await callTool("create_invoice", { customer: "Dublin Ltd", currency: "USD", fxOverrideRate: "0", deliveryDate: "2111-03-06", lines: [{ description: "X", quantity: 1, unitPriceEuro: 1, unit: "HUR" }] });
    expect(bad.isError).toBe(true);
  });
});
