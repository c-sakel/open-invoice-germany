/**
 * Phase 16e, Task 2 — OSS-Kategorie: Produkt -> Snapshot an der Position (create/update/
 * Festschreiben/Storno), REST- und MCP-Validierung, Einstellungen. Eigenes Testjahr 2114
 * (Invoice.number ist global eindeutig).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { prisma, dbInternal, GobdImmutabilityError } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createProduct, updateProduct } from "@/domain/product/save";
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringNow } from "@/domain/recurring/run";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocumentToInvoice } from "@/domain/document/convert";
import { duplicateDocument } from "@/domain/document/duplicate";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { createPartialInvoice } from "@/domain/invoice/partial";
import { createDocumentSchema } from "@/schemas";
import { server } from "@/mcp/server";
import { createInvoiceSchema, type CreateInvoiceInput } from "@/schemas";
import { POST as InvoiceCreate } from "@/app/api/v1/Invoice/route";
import { GET as InvoiceGet } from "@/app/api/v1/Invoice/[id]/route";
import { PATCH as ProductUpdate } from "@/app/api/v1/Product/[id]/route";

const NOW = new Date("2114-05-02T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let customerId: string;
let token: string;
let productId: string;
let foreignProductId: string;

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<ToolResult> }> })._registeredTools;
  return tools[name].handler(args);
}

function line(extra: Record<string, unknown> = {}) {
  return { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, ...extra };
}
function input(lines: Record<string, unknown>[]): CreateInvoiceInput {
  return createInvoiceSchema.parse({ customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", deliveryDate: new Date("2114-05-01"), lines });
}
function req(url: string, opts: { method?: string; body?: unknown } = {}) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}
async function linesOf(invoiceId: string) {
  return dbInternal.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" }, select: { ossCategory: true, lineNetCents: true } });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "OSS-Snapshot GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE123456789", taxNumber: "11/111/11111" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const other = await dbInternal.organization.create({ data: { legalName: "OSS-Fremd GmbH", addressLine1: "X 1", postalCode: "1", city: "X" } });
  otherOrgId = other.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "OSS-Kunde", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
  productId = (await createProduct(orgId, { name: "OSS-Dienst", netPriceCents: 10000, ossCategory: "ELECTRONIC_SERVICE" })).id;
  foreignProductId = (await createProduct(otherOrgId, { name: "Fremd-Dienst", netPriceCents: 10000, ossCategory: "GOODS_DISTANCE" })).id;
  token = (await createApiKey(orgId, { name: "OSS-Key", scopes: ["read", "write", "admin"] })).token;
  resetRateLimits();
});

describe("OSS-Kategorie-Snapshot an der Position", () => {
  it("Produkt -> Snapshot, Freitext -> null, explizit gewinnt", async () => {
    const draft = await createDraftInvoice(orgId, input([line({ productId }), line(), line({ productId, ossCategory: "GOODS_DISTANCE" })]), { now: NOW });
    expect((await linesOf(draft.id)).map((l) => l.ossCategory)).toEqual(["ELECTRONIC_SERVICE", null, "GOODS_DISTANCE"]);
  });

  it("Produkt einer fremden Organisation -> null", async () => {
    const draft = await createDraftInvoice(orgId, input([line({ productId: foreignProductId })]), { now: NOW });
    expect((await linesOf(draft.id)).map((l) => l.ossCategory)).toEqual([null]);
  });

  it("Entwurf aendern setzt den Snapshot aus dem Produkt neu", async () => {
    const draft = await createDraftInvoice(orgId, input([line({ productId })]), { now: NOW });
    await updateProduct(orgId, productId, { ossCategory: "GOODS_DISTANCE" });
    await updateDraftInvoice(orgId, draft.id, { lines: [line({ productId })] }, "test");
    expect((await linesOf(draft.id)).map((l) => l.ossCategory)).toEqual(["GOODS_DISTANCE"]);
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
  });

  it("Festschreiben friert ein; spaetere Produktaenderung und Direktschreiben wirken nicht", async () => {
    const draft = await createDraftInvoice(orgId, input([line({ productId })]), { now: NOW });
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    await updateProduct(orgId, productId, { ossCategory: "NONE" });
    expect((await linesOf(fin.id)).map((l) => l.ossCategory)).toEqual(["ELECTRONIC_SERVICE"]);
    await expect(prisma.invoiceLine.updateMany({ where: { invoiceId: fin.id }, data: { ossCategory: "NONE" } })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
  });

  it("Storno spiegelt die Kategorie", async () => {
    const draft = await createDraftInvoice(orgId, input([line({ productId }), line()]), { now: NOW });
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    const credit = await cancelInvoice(fin.id, { orgId, now: NOW });
    expect((await linesOf(credit.creditNote.id)).map((l) => l.ossCategory)).toEqual(["ELECTRONIC_SERVICE", null]);
  });
});

describe("Weitergabe ueber Folgebelege", () => {
  async function quoteWithOss() {
    return createBusinessDocument(
      orgId,
      createDocumentSchema.parse({ kind: "ANGEBOT", customerId, taxScheme: "REGULAR", lines: [line({ productId }), line({ ossCategory: "GOODS_DISTANCE" }), line()] }),
      { now: NOW },
    );
  }
  const EXPECTED = ["ELECTRONIC_SERVICE", "GOODS_DISTANCE", null];

  it("Angebot speichert den Snapshot an der Position", async () => {
    const q = await quoteWithOss();
    const rows = await dbInternal.quoteLine.findMany({ where: { quoteId: q.id }, orderBy: { position: "asc" }, select: { ossCategory: true } });
    expect(rows.map((r) => r.ossCategory)).toEqual(EXPECTED);
  });

  it("Angebot -> Rechnung uebernimmt die Kategorie (auch nach Produktaenderung)", async () => {
    const q = await quoteWithOss();
    await updateProduct(orgId, productId, { ossCategory: "NONE" });
    const inv = await convertDocumentToInvoice(orgId, q.id, { now: NOW });
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
    expect((await linesOf(inv.id)).map((l) => l.ossCategory)).toEqual(EXPECTED);
  });

  it("Schlussrechnung aus Angebot uebernimmt die Kategorie", async () => {
    const q = await quoteWithOss();
    const down = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q.id, mode: "PERCENT", permille: 100 }, { now: NOW });
    await finalizeInvoice(down.id, { now: NOW });
    const inv = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: q.id }, { now: NOW });
    expect((await linesOf(inv.id)).map((l) => l.ossCategory)).toEqual(EXPECTED);
  });

  it("Teilrechnung (Positionen) aus Angebot uebernimmt die Kategorie", async () => {
    const q = await quoteWithOss();
    const src = await dbInternal.quoteLine.findMany({ where: { quoteId: q.id }, orderBy: { position: "asc" }, select: { id: true } });
    const inv = await createPartialInvoice(orgId, { sourceType: "QUOTE", sourceId: q.id, mode: "POSITIONS", lineIds: src.map((r) => r.id) }, { now: NOW });
    expect((await linesOf(inv.id)).map((l) => l.ossCategory)).toEqual(EXPECTED);
  });

  it("Abo speichert den Snapshot und der Abo-Lauf gibt ihn an die Rechnung weiter", async () => {
    const rec = await createRecurring(orgId, {
      customerId, title: "OSS-Abo", interval: "MONTHLY", intervalCount: 1, startDate: new Date("2114-05-01T09:00:00"),
      taxScheme: "REGULAR", currency: "EUR", paymentTermsDays: 14, autoFinalize: false,
      lines: [line({ productId, lineType: "ITEM" }), line({ ossCategory: "GOODS_DISTANCE" }), line()],
    } as Parameters<typeof createRecurring>[1]);
    const saved = await dbInternal.recurringInvoiceLine.findMany({ where: { recurringInvoiceId: rec.id }, orderBy: { position: "asc" }, select: { ossCategory: true } });
    expect(saved.map((r) => r.ossCategory)).toEqual(EXPECTED);
    await updateProduct(orgId, productId, { ossCategory: "NONE" });
    const emitted = await emitRecurringNow(rec.id, { now: NOW });
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
    const invoiceId = (emitted as { invoiceId?: string; id?: string }).invoiceId ?? (emitted as { id?: string }).id!;
    expect((await linesOf(invoiceId)).map((l) => l.ossCategory)).toEqual(EXPECTED);
  });

  it("Duplizieren einer Rechnung uebernimmt die Kategorie der Quellposition", async () => {
    const src = await createDraftInvoiceFor([line({ productId }), line({ ossCategory: "GOODS_DISTANCE" }), line()]);
    await updateProduct(orgId, productId, { ossCategory: "NONE" });
    const copy = await duplicateDocument(orgId, "INVOICE", src, "test", NOW);
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
    expect((await linesOf(copy.id)).map((l) => l.ossCategory)).toEqual(EXPECTED);
  });

  it("Duplizieren eines Angebots uebernimmt die Kategorie", async () => {
    const q = await quoteWithOss();
    const copy = await duplicateDocument(orgId, "QUOTE", q.id, "test", NOW);
    const rows = await dbInternal.quoteLine.findMany({ where: { quoteId: copy.id }, orderBy: { position: "asc" }, select: { ossCategory: true } });
    expect(rows.map((r) => r.ossCategory)).toEqual(EXPECTED);
  });
});

async function createDraftInvoiceFor(lines: Record<string, unknown>[]): Promise<string> {
  return (await createDraftInvoice(orgId, input(lines), { now: NOW })).id;
}

describe("Entwurf: Randfaelle (Review F3)", () => {
  it("updateDraftInvoice ohne lines behaelt den Snapshot", async () => {
    const id = await createDraftInvoiceFor([line({ productId })]);
    await updateProduct(orgId, productId, { ossCategory: "NONE" });
    await updateDraftInvoice(orgId, id, { subject: "Neuer Betreff", documentDiscountPermille: 100 }, "test");
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
    expect((await linesOf(id)).map((l) => l.ossCategory)).toEqual(["ELECTRONIC_SERVICE"]);
  });

  it("Nicht-ITEM-Zeilen bekommen null, auch mit ossCategory im Input", async () => {
    const id = await createDraftInvoiceFor([
      line({ productId }),
      { lineType: "HEADING", description: "Ueberschrift", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, ossCategory: "GOODS_DISTANCE" },
    ]);
    expect((await linesOf(id)).map((l) => l.ossCategory)).toEqual(["ELECTRONIC_SERVICE", null]);
  });
});

describe("REST und MCP", () => {
  it("POST /Invoice mit ossCategory ohne productId wird gespeichert und ausgeliefert; FOO -> 400", async () => {
    const res = await InvoiceCreate(
      req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, lines: [{ description: "Shop", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19, ossCategory: "ELECTRONIC_SERVICE" }] } }),
    );
    expect(res.status).toBe(201);
    const id = (await res.json()).data.id as string;
    const got = await (await InvoiceGet(req(`http://x/api/v1/Invoice/${id}?embed=lines`), ctxFor(id))).json();
    expect(got.data.lines[0].ossCategory).toBe("ELECTRONIC_SERVICE");

    const bad = await InvoiceCreate(
      req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, lines: [{ description: "Shop", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19, ossCategory: "FOO" }] } }),
    );
    expect(bad.status).toBe(400);
  });

  it("PATCH /Product ohne ossCategory laesst den Wert unveraendert; Antwort enthaelt ihn", async () => {
    const res = await ProductUpdate(req(`http://x/api/v1/Product/${productId}`, { method: "PATCH", body: { name: "OSS-Dienst" } }), ctxFor(productId));
    expect(res.status).toBe(200);
    expect((await res.json()).data.ossCategory).toBe("ELECTRONIC_SERVICE");
    const set = await ProductUpdate(req(`http://x/api/v1/Product/${productId}`, { method: "PATCH", body: { ossCategory: "GOODS_DISTANCE" } }), ctxFor(productId));
    expect((await set.json()).data.ossCategory).toBe("GOODS_DISTANCE");
    await updateProduct(orgId, productId, { ossCategory: "ELECTRONIC_SERVICE" });
  });

  it("MCP upsert_product: ungueltige ossCategory -> Validierungsfehler, gueltige wird gespeichert", async () => {
    const bad = await callTool("upsert_product", { name: "MCP-OSS", netPriceEuro: 10, ossCategory: "FOO" });
    expect(bad.isError).toBe(true);
    const ok = await callTool("upsert_product", { name: "MCP-OSS", netPriceEuro: 10, ossCategory: "GOODS_DISTANCE" });
    expect(ok.isError).toBeFalsy();
    expect((await dbInternal.product.findFirstOrThrow({ where: { orgId, name: "MCP-OSS" } })).ossCategory).toBe("GOODS_DISTANCE");
  });

  it("MCP create_invoice: productName mit eigenem Preis setzt trotzdem den Produkt-Snapshot (Review F2)", async () => {
    const res = await callTool("create_invoice", {
      customer: "OSS-Kunde",
      lines: [{ description: "Eigener Preis", quantity: 1, unitPriceEuro: 77, productName: "OSS-Dienst" }],
    });
    expect(res.isError).toBeFalsy();
    const id = /ID: (\S+)/.exec(res.content[0].text)![1];
    const row = await dbInternal.invoiceLine.findFirstOrThrow({ where: { invoiceId: id }, select: { ossCategory: true, unitNetPriceCents: true } });
    expect(row).toEqual({ ossCategory: "ELECTRONIC_SERVICE", unitNetPriceCents: 7700 });
  });

  it("MCP create_invoice: productName -> Snapshot aus dem Produkt, explizite ossCategory gewinnt", async () => {
    const res = await callTool("create_invoice", {
      customer: "OSS-Kunde",
      lines: [{ description: "", quantity: 1, productName: "OSS-Dienst" }, { description: "Frei", quantity: 1, unitPriceEuro: 10, ossCategory: "GOODS_DISTANCE" }],
    });
    expect(res.isError).toBeFalsy();
    const id = /ID: (\S+)/.exec(res.content[0].text)![1];
    expect((await linesOf(id)).map((l) => l.ossCategory)).toEqual(["ELECTRONIC_SERVICE", "GOODS_DISTANCE"]);
  });
});

describe("Einstellungen", () => {
  it("speichern und laden: BY_PRODUCT / 75", async () => {
    expect((await loadDocumentSettings(orgId)).ossCountMode).toBe("ALL_EU_B2C");
    await saveDocumentSettings(orgId, { ossCountMode: "BY_PRODUCT", ossWarnPercent: 75 });
    const s = await loadDocumentSettings(orgId);
    expect(s.ossCountMode).toBe("BY_PRODUCT");
    expect(s.ossWarnPercent).toBe(75);
  });
});
