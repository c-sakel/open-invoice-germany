/**
 * Phase 18f Task 6: Preis-Eingabe der API — Sub-Cent und Brutto in REST und MCP.
 * Testjahr 2188, Praefixe V18F6- (Rechnung) / A18F6- (Angebot), je Org Nummernkreis ohne Jahresreset.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { POST as InvoicePost } from "@/app/api/v1/Invoice/route";
import { PATCH as InvoicePatch } from "@/app/api/v1/Invoice/[id]/route";
import { POST as QuotePost } from "@/app/api/v1/Quote/route";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let writeToken: string;
let readToken: string;
let otherToken: string;

const line = (extra: Record<string, unknown>) => ({ description: "Dienst", quantityMilli: 1000, unit: "C62", taxRate: 19, ...extra });
const body = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  customerId,
  issueDate: "2188-03-10T10:00:00.000Z",
  deliveryDate: "2188-03-05T00:00:00.000Z",
  lines,
  ...extra,
});

function headers(token: string, key?: string): Headers {
  const h = new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
  if (key) h.set("idempotency-key", key);
  return h;
}
const postInvoice = (b: unknown, opts: { token?: string; key?: string } = {}) =>
  InvoicePost(new Request("http://localhost/api/v1/Invoice", { method: "POST", headers: headers(opts.token ?? writeToken, opts.key), body: typeof b === "string" ? b : JSON.stringify(b) }));
const patchInvoice = (id: string, b: unknown, token = writeToken) =>
  InvoicePatch(new Request(`http://localhost/api/v1/Invoice/${id}`, { method: "PATCH", headers: headers(token), body: JSON.stringify(b) }), { params: Promise.resolve({ id }) });
const postQuote = (b: unknown) => QuotePost(new Request("http://localhost/api/v1/Quote", { method: "POST", headers: headers(writeToken), body: JSON.stringify(b) }));

interface InvoiceData {
  id: string;
  netTotalCents: number;
  grossTotalCents: number;
  status: string;
  grossTargetCents?: number;
  grossDeviationCents?: number;
  lines?: { unitNetPriceCents: number; unitNetPriceMilliCents: number | null }[];
}
const dataOf = async (res: Response) => ((await res.json()) as { data: InvoiceData }).data;
const invoiceCount = () => dbInternal.invoice.count({ where: { orgId } });
const changeLogCount = () => dbInternal.changeLog.count({ where: { orgId } });

// MCP-Client
interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
const client = new Client({ name: "test", version: "1.0.0" });
let connected = false;
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  if (!connected) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    connected = true;
  }
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n").replace(/\s/g, " ");

async function setRange(org: string, docType: string, prefix: string) {
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId: org, docType, year: 0 } },
    create: { orgId: org, docType, year: 0, currentValue: 0, prefix, pattern: "{PREFIX}{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId: org, docType, year: { not: 0 } }, data: { isActive: false } });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Preis API GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  await setRange(orgId, "INVOICE", `V18F6-${orgId.slice(-6)}-`);
  await setRange(orgId, "ANGEBOT", `A18F6-${orgId.slice(-6)}-`);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Preis Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  writeToken = (await createApiKey(orgId, { name: "Preis-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "Preis-Read", scopes: ["read"] })).token;
  const other = await dbInternal.organization.create({ data: { legalName: "Fremd Preis GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" } });
  otherOrgId = other.id;
  otherToken = (await createApiKey(otherOrgId, { name: "Fremd-Write", scopes: ["read", "write"] })).token;
});

beforeEach(() => resetRateLimits());

describe("REST: Rechnung mit Preisformen", () => {
  it("Brutto 2 x 9,99: Netto 16,79, Brutto 19,98, Abweichung 0, Milli-Preis in der Zeile", async () => {
    const res = await postInvoice(body([line({ quantityMilli: 2000, unitGrossPriceCents: 999 })]));
    expect(res.status).toBe(201);
    const d = await dataOf(res);
    expect(d.netTotalCents).toBe(1679);
    expect(d.grossTotalCents).toBe(1998);
    expect(d.grossTargetCents).toBe(1998);
    expect(d.grossDeviationCents).toBe(0);
    const stored = await dbInternal.invoiceLine.findFirstOrThrow({ where: { invoiceId: d.id }, select: { unitNetPriceMilliCents: true } });
    expect(stored.unitNetPriceMilliCents).toBe(839500);
  });

  it("Brutto 1 x 9,99: Abweichung -1, Brutto 9,98", async () => {
    const d = await dataOf(await postInvoice(body([line({ unitGrossPriceCents: 999 })])));
    expect(d.grossTotalCents).toBe(998);
    expect(d.grossTargetCents).toBe(999);
    expect(d.grossDeviationCents).toBe(-1);
  });

  it("Netto-Request: Antwort ohne Brutto-Felder (Schluessel wie vor 18f)", async () => {
    const d = await dataOf(await postInvoice(body([line({ unitNetPriceCents: 1000 })])));
    expect(d).not.toHaveProperty("grossTargetCents");
    expect(d).not.toHaveProperty("grossDeviationCents");
    expect(d.netTotalCents).toBe(1000);
  });

  it("Sub-Cent Nettopreis wird gespeichert (0,002 x 10.000 = 20,00)", async () => {
    const d = await dataOf(await postInvoice(body([line({ quantityMilli: 10_000_000, unitNetPriceMilliCents: 200 })])));
    expect(d.netTotalCents).toBe(2000);
    const stored = await dbInternal.invoiceLine.findFirstOrThrow({ where: { invoiceId: d.id }, select: { unitNetPriceCents: true, unitNetPriceMilliCents: true } });
    expect(stored).toEqual({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 });
  });

  it("finalize + payment 999 bei Abweichung -1: 400 GROSS_DEVIATION, nichts geschrieben; mit 998: 201 PAID", async () => {
    const before = await invoiceCount();
    const logs = await changeLogCount();
    const bad = await postInvoice(body([line({ unitGrossPriceCents: 999 })], { finalize: true, payment: { method: "TRANSFER", amountCents: 999 } }), { key: "v18f6-a" });
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("GROSS_DEVIATION");
    expect(err.error.message).toContain("9,98");
    expect(await invoiceCount()).toBe(before);
    expect(await changeLogCount()).toBe(logs);

    const good = await postInvoice(body([line({ unitGrossPriceCents: 999 })], { finalize: true, payment: { method: "TRANSFER", amountCents: 998 } }), { key: "v18f6-b" });
    expect(good.status).toBe(201);
    const json = (await good.json()) as { data: InvoiceData };
    expect(json.data.status).toBe("PAID");
    expect(json.data.grossDeviationCents).toBe(-1);
    expect(json.data.grossTargetCents).toBe(999);
  });

  it("Validierung: Cent + Brutto, Brutto + Rabatt, Milli ueber Int32, ungueltiges JSON -> 400", async () => {
    const before = await invoiceCount();
    expect((await postInvoice(body([line({ unitNetPriceCents: 5, unitGrossPriceCents: 6 })]))).status).toBe(400);
    expect((await postInvoice(body([line({ unitGrossPriceCents: 999, discountPermille: 100 })]))).status).toBe(400);
    expect((await postInvoice(body([line({ unitNetPriceMilliCents: 2147483648 })]))).status).toBe(400);
    expect((await postInvoice("{kaputt")).status).toBe(400);
    expect(await invoiceCount()).toBe(before);
  });

  it("read-Schluessel -> 403", async () => {
    expect((await postInvoice(body([line({ unitGrossPriceCents: 999 })]), { token: readToken })).status).toBe(403);
  });
});

describe("REST: PATCH und Angebot", () => {
  it("PATCH Entwurf mit Bruttozeilen: umgerechnet, Antwort mit Abweichung", async () => {
    const created = await dataOf(await postInvoice(body([line({ unitNetPriceCents: 1000 })])));
    const res = await patchInvoice(created.id, { lines: [line({ unitGrossPriceCents: 999 })] });
    expect(res.status).toBe(200);
    const d = await dataOf(res);
    expect(d.grossTotalCents).toBe(998);
    expect(d.grossDeviationCents).toBe(-1);
  });

  it("PATCH ohne lines: keine Brutto-Felder", async () => {
    const created = await dataOf(await postInvoice(body([line({ unitNetPriceCents: 1000 })])));
    const d = await dataOf(await patchInvoice(created.id, { subject: "Neu" }));
    expect(d).not.toHaveProperty("grossDeviationCents");
  });

  it("PATCH einer Rechnung fremder Org: 404", async () => {
    const created = await dataOf(await postInvoice(body([line({ unitNetPriceCents: 1000 })])));
    const res = await patchInvoice(created.id, { lines: [line({ unitGrossPriceCents: 999 })] }, otherToken);
    expect(res.status).toBe(404);
  });

  it("Angebot mit Milli-Zeile wird gespeichert; Milli ueber Int32 -> 400", async () => {
    const res = await postQuote({ customerId, lines: [line({ quantityMilli: 10_000_000, unitNetPriceMilliCents: 200 })] });
    expect(res.status).toBe(201);
    const d = await dataOf(res);
    const stored = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: d.id }, select: { unitNetPriceMilliCents: true } });
    expect(stored.unitNetPriceMilliCents).toBe(200);
    expect((await postQuote({ customerId, lines: [line({ unitNetPriceMilliCents: 2147483648 })] })).status).toBe(400);
  });
});

describe("MCP: Preise", () => {
  const mcpArgs = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ customer: "Preis Kunde AG", lines, ...extra });

  it("create_invoice unitPriceEuro 0.002 x 10000: Netto 20,00, Text nennt 0,002 €", async () => {
    const r = await callTool("create_invoice", mcpArgs([{ description: "Mengenposten", quantity: 10000, unitPriceEuro: 0.002, taxRatePercent: 19 }]));
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Netto: 20,00 €");
    expect(text(r)).toContain("0,002 €");
  });

  it("create_invoice unitGrossPriceEuro 9.99: Umrechnung und Abweichungshinweis", async () => {
    const r = await callTool("create_invoice", mcpArgs([{ description: "Brutto", quantity: 1, unitGrossPriceEuro: 9.99, taxRatePercent: 19 }]));
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Bruttopreise je Steuersatz in Netto umgerechnet");
    expect(text(r)).toContain("Bruttosumme weicht um -0,01 € ab");
  });

  it("zu viele Nachkommastellen -> ToolError, keine Rechnung", async () => {
    const before = await invoiceCount();
    const r = await callTool("create_invoice", mcpArgs([{ description: "X", quantity: 1, unitPriceEuro: 0.0000001 }]));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("höchstens 5 Nachkommastellen");
    expect(await invoiceCount()).toBe(before);
  });

  it("unitPriceEuro + unitGrossPriceEuro -> ToolError", async () => {
    const r = await callTool("create_invoice", mcpArgs([{ description: "X", quantity: 1, unitPriceEuro: 1, unitGrossPriceEuro: 1.19 }]));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("schließen sich aus");
  });

  it("finalize + payment bei Abweichung: GROSS_DEVIATION-Text, nichts geschrieben", async () => {
    const before = await invoiceCount();
    const r = await callTool("create_invoice", mcpArgs([{ description: "B", quantity: 1, unitGrossPriceEuro: 9.99, taxRatePercent: 19 }], { finalize: true, idempotencyKey: "v18f6-m1", payment: { amountEuro: 9.99 }, deliveryDate: "2188-03-05" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("9,98");
    expect(await invoiceCount()).toBe(before);
  });

  it("update_invoice_draft: Sub-Cent bleibt erhalten, Brutto wird umgerechnet", async () => {
    const created = await callTool("create_invoice", mcpArgs([{ description: "Start", quantity: 1, unitPriceEuro: 10 }]));
    const id = /ID: (\S+)/.exec(text(created))![1];
    const sub = await callTool("update_invoice_draft", { invoice: id, lines: [{ description: "Menge", quantity: 10000, unitPriceEuro: 0.002 }] });
    expect(sub.isError).toBeFalsy();
    expect(text(sub)).toContain("Netto 20,00 €");
    expect(text(sub)).toContain("0,002 €");
    const stored = await dbInternal.invoiceLine.findFirstOrThrow({ where: { invoiceId: id }, select: { unitNetPriceMilliCents: true } });
    expect(stored.unitNetPriceMilliCents).toBe(200);
    const gross = await callTool("update_invoice_draft", { invoice: id, lines: [{ description: "Brutto", quantity: 1, unitGrossPriceEuro: 9.99, taxRatePercent: 19 }] });
    expect(gross.isError).toBeFalsy();
    expect(text(gross)).toContain("Bruttosumme weicht um -0,01 € ab");
    const bad = await callTool("update_invoice_draft", { invoice: id, lines: [{ description: "X", quantity: 1, unitPriceEuro: 0.0000001 }] });
    expect(bad.isError).toBe(true);
  });

  it("create_document: Sub-Cent und Brutto", async () => {
    const sub = await callTool("create_document", { kind: "ANGEBOT", customer: "Preis Kunde AG", lines: [{ description: "Menge", quantity: 10000, unitPriceEuro: 0.002 }] });
    expect(sub.isError).toBeFalsy();
    expect(text(sub)).toContain("0,002 €");
    const gross = await callTool("create_document", { kind: "ANGEBOT", customer: "Preis Kunde AG", lines: [{ description: "B", quantity: 1, unitGrossPriceEuro: 9.99 }] });
    expect(gross.isError).toBeFalsy();
    expect(text(gross)).toContain("Bruttosumme weicht um -0,01 € ab");
    const mix = await callTool("create_document", { kind: "ANGEBOT", customer: "Preis Kunde AG", lines: [{ description: "B", quantity: 1, unitGrossPriceEuro: 9.99, discountPercent: 10 }] });
    expect(mix.isError).toBe(true);
  });

  it("Tools ohne Bruttounterstuetzung lehnen unitGrossPriceEuro ab, Teilgutschrift lehnt Sub-Cent ab", async () => {
    const r = await callTool("create_delivery_note", { customer: "Preis Kunde AG", draft: true, lines: [{ description: "L", quantity: 1, unitGrossPriceEuro: 1.19 }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("nicht unterstützt");
  });
});
