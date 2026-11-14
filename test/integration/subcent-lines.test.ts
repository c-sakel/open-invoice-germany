/**
 * Phase 18f, Task 3 — Einzelpreise in tausendstel Cent in Rechnung, Angebot und allen
 * Kopierpfaden (Storno, Duplikat, Umwandlung, Vorlage, Uebernahme, Schluss-/Teilrechnung).
 * Testjahr 2185 (Invoice.number ist global eindeutig), Praefix V18F3-.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocumentToInvoice, convertDocument } from "@/domain/document/convert";
import { duplicateDocument } from "@/domain/document/duplicate";
import { createPartialInvoice } from "@/domain/invoice/partial";
import { createFinalInvoice } from "@/domain/invoice/final";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { saveTemplateFromDocument } from "@/domain/template/save";
import { applyTemplate } from "@/domain/template/apply";
import { buildTakeOverPrefill } from "@/domain/document/take-over";
import { serializeInvoiceLine, serializeQuoteLine } from "@/api/serializers/lines";
import { computeLineNet } from "@/lib/pricing/line";
import { createInvoiceSchema } from "@/schemas";

const NOW = new Date("2185-03-10T10:00:00.000Z");
const START = new Date("2185-03-01T00:00:00.000Z");
const END = new Date("2185-03-31T00:00:00.000Z");

let orgId: string;
let customerId: string;

const lineA = { lineType: "ITEM" as const, description: "API-Aufrufe", quantityMilli: 10_000_000, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0, discountCents: 0, servicePeriodStart: START, servicePeriodEnd: END };
const lineB = { lineType: "ITEM" as const, description: "Grundgebuehr", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 2900, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0, discountCents: 0 };

async function invoiceLines(id: string) {
  return dbInternal.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { position: "asc" } });
}
async function quoteLines(id: string) {
  return dbInternal.quoteLine.findMany({ where: { quoteId: id }, orderBy: { position: "asc" } });
}
function newInvoice(extra: Record<string, unknown> = {}) {
  return createDraftInvoice(orgId, createInvoiceSchema.parse({ customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA, lineB], ...extra }), { now: NOW });
}
function newQuote(lines: unknown[] = [lineA, lineB]) {
  return createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines } as never, { now: NOW });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "V18F3-Org GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lueneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({ data: { orgId, name: "V18F3-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } });
  customerId = customer.id;
  await ensureOrgMasterdata(dbInternal, orgId);
});

describe("Rechnung: Persistenz und Summen", () => {
  it("speichert Milli-Preis und Zeitraum, rechnet Zeilen exakt, Summen 4900/931/5831", async () => {
    const inv = await newInvoice();
    const lines = await invoiceLines(inv.id);
    expect(lines.map((l) => l.lineNetCents)).toEqual([2000, 2900]);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.unitNetPriceCents).toBe(0);
    expect(lines[0]!.servicePeriodStart?.toISOString()).toBe(START.toISOString());
    expect(lines[0]!.servicePeriodEnd?.toISOString()).toBe(END.toISOString());
    expect(lines[1]!.unitNetPriceMilliCents).toBeNull();
    expect(lines[1]!.servicePeriodStart).toBeNull();
    expect(inv.netTotalCents).toBe(4900);
    expect(inv.taxTotalCents).toBe(931);
    expect(inv.grossTotalCents).toBe(5831);
  });

  it("updateDraft mit Milli 150 ergibt 1500", async () => {
    const inv = await newInvoice();
    const updated = await updateDraftInvoice(orgId, inv.id, { lines: [{ ...lineA, unitNetPriceCents: 0, unitNetPriceMilliCents: 150 }, lineB] }, "test");
    const lines = await invoiceLines(updated.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(150);
    expect(lines[0]!.lineNetCents).toBe(1500);
    expect(updated.netTotalCents).toBe(4400);
  });

  it("Entwurf ohne neue Zeilen behaelt Milli-Preis beim Aktualisieren anderer Felder", async () => {
    const inv = await newInvoice();
    await updateDraftInvoice(orgId, inv.id, { notes: "nur Notiz" }, "test");
    const lines = await invoiceLines(inv.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.servicePeriodStart).not.toBeNull();
  });

  it("Bestandsrechnung ohne Milli: Netto und Serializer wie vor 18f", async () => {
    const inv = await createDraftInvoice(orgId, createInvoiceSchema.parse({ customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineB] }), { now: NOW });
    const [l] = await invoiceLines(inv.id);
    expect(l!.lineNetCents).toBe(computeLineNet({ quantityMilli: 1000, unitNetPriceCents: 2900 }).lineNetCents);
    const s = serializeInvoiceLine(l!);
    expect(s.unitNetPriceMilliCents).toBeNull();
    expect(s.servicePeriodStart).toBeNull();
    expect(s.servicePeriodEnd).toBeNull();
  });

  it("Serializer liefert Milli-Preis und Zeitraum als ISO", async () => {
    const inv = await newInvoice();
    const [a] = await invoiceLines(inv.id);
    const s = serializeInvoiceLine(a!);
    expect(s.unitNetPriceMilliCents).toBe(200);
    expect(s.servicePeriodStart).toBe(START.toISOString());
    expect(s.servicePeriodEnd).toBe(END.toISOString());
  });

  it("weist inkonsistenten Cent-Preis zurueck", () => {
    expect(() => newInvoice({ lines: [{ ...lineA, unitNetPriceCents: 1 }] })).toThrow(/muss 0 sein/);
  });
});

describe("Storno", () => {
  it("spiegelt Milli-Preis und Zeitraum", async () => {
    const inv = await newInvoice();
    await finalizeInvoice(inv.id, { now: NOW });
    const res = await cancelInvoice(inv.id, { orgId, now: NOW });
    const creditId = (res as { creditNote?: { id: string }; credit?: { id: string } }).creditNote?.id ?? (res as { credit?: { id: string } }).credit?.id;
    expect(creditId).toBeDefined();
    const lines = await invoiceLines(creditId!);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(-200);
    expect(lines[0]!.unitNetPriceCents).toBe(0);
    expect(lines[0]!.lineNetCents).toBe(-2000);
    expect(lines[0]!.servicePeriodStart?.toISOString()).toBe(START.toISOString());
    expect(lines[0]!.servicePeriodEnd?.toISOString()).toBe(END.toISOString());
    expect(lines[1]!.unitNetPriceMilliCents).toBeNull();
    expect(lines[1]!.unitNetPriceCents).toBe(-2900);
  });
});

describe("Angebot und Kopierpfade", () => {
  it("Angebot speichert Milli-Preis", async () => {
    const q = await newQuote();
    const lines = await quoteLines(q.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.lineNetCents).toBe(2000);
    expect(serializeQuoteLine(lines[0]!).unitNetPriceMilliCents).toBe(200);
  });

  it("Duplikat (Rechnung und Angebot) traegt den Milli-Preis", async () => {
    const inv = await newInvoice();
    const dupInv = await duplicateDocument(orgId, "INVOICE", inv.id, "test", NOW);
    expect((await invoiceLines(dupInv.id))[0]!.unitNetPriceMilliCents).toBe(200);
    const q = await newQuote();
    const dupQ = await duplicateDocument(orgId, "QUOTE", q.id, "test", NOW);
    const ql = await quoteLines(dupQ.id);
    expect(ql[0]!.unitNetPriceMilliCents).toBe(200);
    expect(ql[0]!.lineNetCents).toBe(2000);
  });

  it("Angebot -> Rechnung (convertDocumentToInvoice)", async () => {
    const q = await newQuote();
    const inv = await convertDocumentToInvoice(orgId, q.id, { now: NOW });
    const lines = await invoiceLines(inv.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.lineNetCents).toBe(2000);
    expect(inv.netTotalCents).toBe(4900);
  });

  it("Angebot -> Auftragsbestaetigung", async () => {
    const q = await newQuote();
    const res = await convertDocument(orgId, { fromType: "QUOTE", fromId: q.id, toKind: "AUFTRAGSBESTAETIGUNG" }, { now: NOW });
    expect((await quoteLines(res.id))[0]!.unitNetPriceMilliCents).toBe(200);
  });

  it("Vorlage speichern und anwenden (Rechnung); Altvorlage ohne Schluessel -> null", async () => {
    const inv = await newInvoice();
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: "V18F3-Vorlage" });
    expect(JSON.parse(tpl.payloadJson).lines[0].unitNetPriceMilliCents).toBe(200);
    const applied = await applyTemplate(orgId, tpl.id, {});
    const lines = await invoiceLines(applied.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.lineNetCents).toBe(2000);

    const payload = JSON.parse(tpl.payloadJson) as { lines: Record<string, unknown>[] };
    for (const l of payload.lines) delete l.unitNetPriceMilliCents;
    payload.lines[0]!.unitNetPriceCents = 5;
    const old = await dbInternal.documentTemplate.create({ data: { orgId, name: "V18F3-Altvorlage", docType: "INVOICE", customerId, payloadJson: JSON.stringify(payload) } });
    const appliedOld = await applyTemplate(orgId, old.id, {});
    const oldLines = await invoiceLines(appliedOld.id);
    expect(oldLines[0]!.unitNetPriceMilliCents).toBeNull();
    expect(oldLines[0]!.unitNetPriceCents).toBe(5);
  });

  it("Uebernahme des letzten Belegs", async () => {
    const inv = await newInvoice();
    const prefill = await buildTakeOverPrefill(orgId, inv.id, { lines: true, texts: false, terms: false, prices: true });
    expect(prefill.lines![0]!.unitNetPriceMilliCents).toBe(200);
    const noPrices = await buildTakeOverPrefill(orgId, inv.id, { lines: true, texts: false, terms: false, prices: false });
    expect(noPrices.lines![0]!.unitNetPriceMilliCents).toBeNull();
    expect(noPrices.lines![0]!.unitNetPriceCents).toBe(0);
  });

  it("Schlussrechnung aus Angebot", async () => {
    const q = await newQuote();
    const dp = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q.id, mode: "PERCENT", permille: 300 }, { now: NOW });
    await finalizeInvoice(dp.id, { now: NOW });
    const inv = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: q.id }, { now: NOW });
    const lines = await invoiceLines(inv.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.lineNetCents).toBe(2000);
  });

  it("Teilrechnung QUANTITIES (Menge 5.000 von 10.000) -> Netto 1000", async () => {
    const q = await newQuote([lineA]);
    const src = (await quoteLines(q.id))[0]!;
    const inv = await createPartialInvoice(orgId, { sourceType: "QUOTE", sourceId: q.id, mode: "QUANTITIES", quantities: [{ sourceLineId: src.id, quantityMilli: 5_000_000 }] }, { now: NOW });
    const lines = await invoiceLines(inv.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.lineNetCents).toBe(1000);
    expect(inv.netTotalCents).toBe(1000);
  });

  it("Lieferschein aus Angebot speichert nur Cent (dokumentierte Grenze)", async () => {
    const q = await newQuote();
    const res = await convertDocument(orgId, { fromType: "QUOTE", fromId: q.id, toKind: "DELIVERY_NOTE" }, { now: NOW });
    const dnLines = await dbInternal.deliveryNoteLine.findMany({ where: { deliveryNoteId: res.id }, orderBy: { position: "asc" } });
    expect(dnLines[0]!.unitNetPriceCents).toBe(0);
  });

  it("Teilrechnung aus dem Lieferschein erbt den Milli-Preis der Quellposition", async () => {
    const q = await newQuote([lineA]);
    const res = await convertDocument(orgId, { fromType: "QUOTE", fromId: q.id, toKind: "DELIVERY_NOTE" }, { now: NOW });
    const dnLine = (await dbInternal.deliveryNoteLine.findMany({ where: { deliveryNoteId: res.id } }))[0]!;
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: res.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: NOW });
    const lines = await invoiceLines(inv.id);
    expect(lines[0]!.unitNetPriceMilliCents).toBe(200);
    expect(lines[0]!.lineNetCents).toBe(2000);
  });
});
