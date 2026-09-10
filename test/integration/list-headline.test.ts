/**
 * Phase 13a, Task 4 — Kopfkennzahlen ueber der Rechnungsliste (`invoiceListHeadline`).
 *
 * Fixtures werden direkt ueber `dbInternal.invoice.create` angelegt (wie in
 * list-tabs.test.ts fuer Detail-Manipulationen etabliert) statt ueber die volle
 * createDraftInvoice/finalizeInvoice/recordPayment-Kette — die Kennzahl haengt nur an
 * gespeicherten Spalten (status/dueDate/grossTotalCents/paidAmountCents/payableCents),
 * keine Positionen/Snapshots noetig. Jede Fallgruppe traegt eine eindeutige Belegnummer
 * (instanzweit @unique) und wird ueber `customerId`/`number` isoliert abgefragt, damit
 * Fallgruppen sich nicht gegenseitig in die Summen mischen.
 *
 * Eigenes Jahr 2065 (Brief-Vorgabe) — laut Testjahr-Konvention (grep "Eigenes Jahr" ueber
 * test/) unbenutzt.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { invoiceListHeadline } from "@/domain/invoice/list";

let orgId: string;
let baseCustomerId: string;

const NOW = new Date(Date.UTC(2065, 5, 15, 10, 0, 0));
const YESTERDAY = new Date(Date.UTC(2065, 5, 14));
const IN_10_DAYS = new Date(Date.UTC(2065, 5, 25));

async function rawInvoice(data: {
  number: string;
  status: string;
  type?: string;
  currency?: string;
  dueDate?: Date | null;
  grossTotalCents: number;
  paidAmountCents?: number;
  payableCents?: number | null;
  prepaidCents?: number;
  customerId?: string;
}) {
  return dbInternal.invoice.create({
    data: {
      orgId,
      customerId: data.customerId ?? baseCustomerId,
      number: data.number,
      status: data.status,
      type: data.type ?? "INVOICE",
      currency: data.currency ?? "EUR",
      issueDate: NOW,
      dueDate: data.dueDate ?? null,
      grossTotalCents: data.grossTotalCents,
      paidAmountCents: data.paidAmountCents ?? 0,
      payableCents: data.payableCents ?? null,
      prepaidCents: data.prepaidCents ?? 0,
    },
  });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Kopfkennzahlen Test GmbH",
      addressLine1: "Summenweg 1",
      postalCode: "24941",
      city: "Flensburg",
      vatId: "DE999888777",
      taxNumber: "21/555/99998",
    },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kopfkennzahlen-Kunde AG", addressLine1: "Ringstr. 9", postalCode: "24939", city: "Flensburg", type: "BUSINESS" },
  });
  baseCustomerId = customer.id;

  // Basisszenario (Brief): 2 offen, 1 ueberfaellig, 1 teilbezahlt+ueberfaellig, 1 bezahlt,
  // 1 Entwurf.
  await rawInvoice({ number: "HL65-BASE-1", status: "SENT", dueDate: null, grossTotalCents: 11900 }); // offen 119,00 EUR
  await rawInvoice({ number: "HL65-BASE-2", status: "SENT", dueDate: IN_10_DAYS, grossTotalCents: 23800 }); // offen 238,00 EUR
  await rawInvoice({ number: "HL65-BASE-3", status: "FINALIZED", dueDate: YESTERDAY, grossTotalCents: 10000 }); // ueberfaellig 100,00 EUR
  await rawInvoice({ number: "HL65-BASE-4", status: "PARTIALLY_PAID", dueDate: YESTERDAY, grossTotalCents: 20000, paidAmountCents: 5000 }); // Brutto 200,00, Zahlung 50,00 => offen 150,00
  await rawInvoice({ number: "HL65-BASE-5", status: "PAID", dueDate: YESTERDAY, grossTotalCents: 30000, paidAmountCents: 30000 }); // bezahlt 300,00
  await rawInvoice({ number: "HL65-BASE-6", status: "DRAFT", dueDate: null, grossTotalCents: 5000 }); // Entwurf 50,00

  // Fall A: Schlussrechnung mit payableCents < grossTotalCents (Abschlag bereits vereinnahmt).
  await rawInvoice({
    number: "HL65-FINAL-A",
    status: "FINALIZED",
    type: "FINAL",
    dueDate: null,
    grossTotalCents: 50000,
    prepaidCents: 20000,
    payableCents: 30000,
  });

  // Fall B: ueberzahlte Rechnung (paidAmountCents > grossTotalCents).
  await rawInvoice({ number: "HL65-OVERPAY-B", status: "PARTIALLY_PAID", dueDate: null, grossTotalCents: 10000, paidAmountCents: 15000 });

  // Fall D: zweite Waehrung.
  await rawInvoice({ number: "HL65-CUR-EUR", status: "DRAFT", currency: "EUR", grossTotalCents: 1000 });
  await rawInvoice({ number: "HL65-CUR-CHF", status: "DRAFT", currency: "CHF", grossTotalCents: 2000 });
});

describe("invoiceListHeadline", () => {
  it("Basisszenario: count/grossCents ueber ALLE sechs, openCents/overdueCents nur ueber die faelligen/ueberfaelligen", async () => {
    const h = await invoiceListHeadline(orgId, { customerId: baseCustomerId, number: "HL65-BASE-" }, NOW);
    expect(h.count).toBe(6);
    expect(h.grossCents).toBe(11900 + 23800 + 10000 + 20000 + 30000 + 5000);
    expect(h.openCents).toBe(11900 + 23800 + 10000 + 15000);
    expect(h.overdueCents).toBe(10000 + 15000);
    expect(h.mixedCurrency).toBe(false);
  });

  it("Schlussrechnung: openCents folgt openAmountCents (payableCents), nicht gross - paid", async () => {
    const h = await invoiceListHeadline(orgId, { number: "HL65-FINAL-A" }, NOW);
    expect(h.count).toBe(1);
    expect(h.grossCents).toBe(50000);
    expect(h.openCents).toBe(30000);
    expect(h.overdueCents).toBe(0);
  });

  it("ueberzahlte Rechnung: openCents wird nicht negativ", async () => {
    const h = await invoiceListHeadline(orgId, { number: "HL65-OVERPAY-B" }, NOW);
    expect(h.count).toBe(1);
    expect(h.grossCents).toBe(10000);
    expect(h.openCents).toBe(0);
    expect(h.overdueCents).toBe(0);
  });

  it("Statusfilter 'overdue': Kennzahlen folgen dem Filter, nicht der Gesamtmenge", async () => {
    const h = await invoiceListHeadline(orgId, { customerId: baseCustomerId, number: "HL65-BASE-", status: "overdue" }, NOW);
    expect(h.count).toBe(2);
    expect(h.grossCents).toBe(10000 + 20000);
    expect(h.openCents).toBe(10000 + 15000);
    expect(h.overdueCents).toBe(10000 + 15000);
  });

  it("zweite Waehrung: mixedCurrency statt stillschweigend addierter Summe", async () => {
    const h = await invoiceListHeadline(orgId, { number: "HL65-CUR-" }, NOW);
    expect(h.count).toBe(2);
    expect(h.grossCents).toBe(1000 + 2000);
    expect(h.mixedCurrency).toBe(true);
  });
});
