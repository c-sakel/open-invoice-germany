/**
 * Phase 13a, Task 5 — `deriveBillingState` (geteilte Regel) und `billingStateIndex`
 * (Bulk-Index ueber alle Angebote einer Organisation).
 *
 * Zehn Konstellationen (Brief) werden ueber die ECHTEN Domain-Flows angelegt (Konvertierung/
 * Teil-/Abschlags-/Schlussrechnung, Festschreibung, Storno) statt manuell eingefuegter
 * DocumentRelation-Zeilen — nur so entstehen dieselben Relationen/Status-Kombinationen wie
 * in Produktion, gegen die `billingStateFor` bereits in partial-invoices.test.ts und
 * document-chain.test.ts geprueft ist.
 *
 * Eigenes Jahr: 2089 statt der im Brief genannten 2066 — 2066 ist bereits durch
 * dashboard-overview.test.ts belegt (finalisiert dort mehrere echte Rechnungen ueber
 * assignDocumentNumber, Format "RE-<Jahr>-000N" je Org; "Invoice.number" ist instanzweit
 * @unique, nicht je Org — zwei Organisationen im selben Jahr wuerden beim jeweils ersten
 * Beleg dieselbe formatierte Nummer ziehen). 2089 ist laut Testjahr-Konvention (grep
 * "Eigenes Jahr" ueber test/) unbenutzt.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocumentToInvoice } from "@/domain/document/convert";
import { createPartialInvoice } from "@/domain/invoice/partial";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { billingStateFor, billingStateIndex } from "@/domain/document/billing-state";
import type { BillingState } from "@/schemas";

const FIX_DATE = new Date("2089-05-01T10:00:00.000Z");

let orgId: string;
let customerId: string;
const quoteIds: Record<string, string> = {};

async function makeQuote(netCents: number) {
  return createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [
        { lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 },
      ],
    },
    { now: FIX_DATE },
  );
}

async function makeQuantityQuote(unitNetCents: number, quantityMilli: number) {
  return createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [
        { lineType: "ITEM", description: "Stunden", quantityMilli, unit: "HUR", unitNetPriceCents: unitNetCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 },
      ],
    },
    { now: FIX_DATE },
  );
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Abrechnungsstand-Index GmbH", addressLine1: "Indexweg 1", postalCode: "24941", city: "Flensburg", vatId: "DE444555666", taxNumber: "21/555/44445" },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Index-Kunde AG", addressLine1: "Ringstr. 12", postalCode: "24939", city: "Flensburg", type: "BUSINESS" },
  });
  customerId = customer.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  // 1: ohne Rechnung.
  const q1 = await makeQuote(100_000);
  quoteIds["ohne Rechnung"] = q1.id;

  // 2: umgewandelt (CONVERTED_TO, aktive Rechnung).
  const q2 = await makeQuote(100_000);
  await convertDocumentToInvoice(orgId, q2.id, { now: FIX_DATE });
  quoteIds["umgewandelt"] = q2.id;

  // 3: umgewandelt, aber die Rechnung wurde storniert.
  const q3 = await makeQuote(100_000);
  const inv3 = await convertDocumentToInvoice(orgId, q3.id, { now: FIX_DATE });
  const finalized3 = await finalizeInvoice(inv3.id, { now: FIX_DATE });
  await cancelInvoice(finalized3.id, { now: FIX_DATE });
  quoteIds["umgewandelt+storniert"] = q3.id;

  // 4: ein Abschlag ueber 30 %.
  const q4 = await makeQuote(100_000);
  await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q4.id, mode: "PERCENT", permille: 300 }, { now: FIX_DATE });
  quoteIds["ein Abschlag 30%"] = q4.id;

  // 5: zwei Abschlaege, die zusammen genau 100 % erreichen.
  const q5 = await makeQuote(100_000);
  await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q5.id, mode: "PERCENT", permille: 500 }, { now: FIX_DATE });
  await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q5.id, mode: "PERCENT", permille: 500 }, { now: FIX_DATE });
  quoteIds["Abschlaege zusammen 100%"] = q5.id;

  // 6: eine Teilrechnung ueber ALLE bestellten Mengen (Mengendeckung).
  const q6 = await makeQuantityQuote(10_000, 10_000);
  const sourceLineId6 = q6.lines[0].id;
  await createPartialInvoice(orgId, { sourceType: "QUOTE", sourceId: q6.id, mode: "QUANTITIES", quantities: [{ sourceLineId: sourceLineId6, quantityMilli: 10_000 }] }, { now: FIX_DATE });
  quoteIds["Teilrechnung alle Mengen"] = q6.id;

  // 7: eine Teilrechnung ueber die HALBE bestellte Menge.
  const q7 = await makeQuantityQuote(10_000, 10_000);
  const sourceLineId7 = q7.lines[0].id;
  await createPartialInvoice(orgId, { sourceType: "QUOTE", sourceId: q7.id, mode: "QUANTITIES", quantities: [{ sourceLineId: sourceLineId7, quantityMilli: 5_000 }] }, { now: FIX_DATE });
  quoteIds["Teilrechnung halbe Mengen"] = q7.id;

  // 8: ein Abschlag + eine FESTGESCHRIEBENE Schlussrechnung.
  const q8 = await makeQuote(100_000);
  const dp8 = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q8.id, mode: "PERCENT", permille: 300 }, { now: FIX_DATE });
  await finalizeInvoice(dp8.id, { now: FIX_DATE });
  const final8 = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: q8.id }, { now: FIX_DATE });
  await finalizeInvoice(final8.id, { now: FIX_DATE });
  quoteIds["festgeschriebene Schlussrechnung"] = q8.id;

  // 9: ein Abschlag + eine Schlussrechnung, die NUR als Entwurf existiert.
  const q9 = await makeQuote(100_000);
  const dp9 = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: q9.id, mode: "PERCENT", permille: 300 }, { now: FIX_DATE });
  await finalizeInvoice(dp9.id, { now: FIX_DATE });
  await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: q9.id }, { now: FIX_DATE }); // bleibt DRAFT
  quoteIds["Schlussrechnung nur Entwurf"] = q9.id;

  // 10: nur STORNIERTE Teilrechnungen.
  const q10 = await makeQuantityQuote(10_000, 10_000);
  const sourceLineId10 = q10.lines[0].id;
  const p10 = await createPartialInvoice(
    orgId,
    { sourceType: "QUOTE", sourceId: q10.id, mode: "QUANTITIES", quantities: [{ sourceLineId: sourceLineId10, quantityMilli: 4_000 }] },
    { now: FIX_DATE },
  );
  const finalizedP10 = await finalizeInvoice(p10.id, { now: FIX_DATE });
  await cancelInvoice(finalizedP10.id, { now: FIX_DATE });
  quoteIds["nur stornierte Teilrechnungen"] = q10.id;
});

describe("Fixtur-Kontrolle: billingStateFor liefert den erwarteten Zustand je Konstellation", () => {
  it("deckt FULL/PARTIAL/NONE aus allen vier Relationstypen ab", async () => {
    const expected: Record<string, BillingState> = {
      "ohne Rechnung": "NONE",
      umgewandelt: "FULL",
      "umgewandelt+storniert": "NONE",
      "ein Abschlag 30%": "PARTIAL",
      "Abschlaege zusammen 100%": "FULL",
      "Teilrechnung alle Mengen": "FULL",
      "Teilrechnung halbe Mengen": "PARTIAL",
      "festgeschriebene Schlussrechnung": "FULL",
      "Schlussrechnung nur Entwurf": "PARTIAL",
      "nur stornierte Teilrechnungen": "NONE",
    };
    for (const [name, quoteId] of Object.entries(quoteIds)) {
      const state = await billingStateFor(orgId, "QUOTE", quoteId);
      expect({ name, state: state.state }).toEqual({ name, state: expected[name] });
    }
  });
});

describe("billingStateIndex", () => {
  it("liefert fuer jede Konstellation exakt dasselbe wie billingStateFor", async () => {
    const index = await billingStateIndex(orgId);
    expect(index.available).toBe(true);
    for (const [name, quoteId] of Object.entries(quoteIds)) {
      const single = await billingStateFor(orgId, "QUOTE", quoteId);
      expect({ name, state: index.states.get(quoteId) }).toEqual({ name, state: single.state });
    }
  });

  it("der Index ruft nie die Einzelabfrage und bleibt bei hoechstens fuenf Bulk-Abfragen", () => {
    const body = readFileSync("src/domain/document/billing-state.ts", "utf8").split("export const billingStateIndex")[1];
    expect(body).not.toMatch(/billingStateFor/);
    expect((body.match(/findMany|groupBy/g) ?? []).length).toBeLessThanOrEqual(5);
  });
});
