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
import { beforeAll, describe, it, expect, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocumentToInvoice } from "@/domain/document/convert";
import { createPartialInvoice } from "@/domain/invoice/partial";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { billingStateFor, billingStateIndex, billingFilterIds } from "@/domain/document/billing-state";
import { quoteStatusTabCounts, listQuotes } from "@/domain/document/list";
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
  await cancelInvoice(finalized3.id, { orgId: finalized3.orgId, now: FIX_DATE });
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
  await cancelInvoice(finalizedP10.id, { orgId: finalizedP10.orgId, now: FIX_DATE });
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
    for (const [name, quoteId] of Object.entries(quoteIds)) {
      const single = await billingStateFor(orgId, "QUOTE", quoteId);
      // Task 8 (Nachtrag, Review-Finding): der Index traegt seit Task 8 NUR noch Angebote
      // mit mindestens einer billingrelevanten Relation (Bulk-Abfrage 3 laeuft nicht mehr
      // ueber ALLE Angebote der Organisation) — "ohne Rechnung" hat also gar keinen
      // Map-Eintrag mehr (`undefined`), was per Vertrag "NONE" bedeutet (siehe
      // BillingStateIndex.states-Kommentar). Alle Konstellationen MIT Relation (auch die
      // drei, deren einzige Relation zu einer stornierten Rechnung fuehrt) bleiben im Index.
      expect({ name, state: index.states.get(quoteId) ?? "NONE" }).toEqual({ name, state: single.state });
    }
    expect(index.states.has(quoteIds["ohne Rechnung"])).toBe(false);
  });

  it("der Index ruft nie die Einzelabfrage und bleibt bei hoechstens fuenf Bulk-Abfragen", () => {
    const body = readFileSync("src/domain/document/billing-state.ts", "utf8").split("export const billingStateIndex")[1];
    expect(body).not.toMatch(/billingStateFor/);
    expect((body.match(/findMany|groupBy/g) ?? []).length).toBeLessThanOrEqual(5);
  });
});

describe("quoteStatusTabCounts — billed/partially-billed (Task 8, Review-Finding T4)", () => {
  it("zaehlt FULL/PARTIAL exakt entsprechend der zehn Konstellationen oben", async () => {
    const counts = await quoteStatusTabCounts(orgId, {}, FIX_DATE);
    // Aus der Fixtur-Kontrolle oben: 4x FULL (umgewandelt, Abschlaege zusammen 100%,
    // Teilrechnung alle Mengen, festgeschriebene Schlussrechnung), 3x PARTIAL (ein
    // Abschlag 30%, Teilrechnung halbe Mengen, Schlussrechnung nur Entwurf).
    expect(counts.billed).toBe(4);
    expect(counts["partially-billed"]).toBe(3);
  });
});

// ── Phase 17c, Task 5: Index ohne Obergrenze (Testjahr 2153, Praefix C17T5-; es entstehen nur
// Entwuerfe/Rohzeilen ohne Belegnummer, kein Nummernkreis betroffen). ─────────────────────────
const DAY = 86_400_000;
const START17 = Date.UTC(2153, 0, 1);

function part<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

async function newOrg(name: string) {
  const org = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Massenweg 1", postalCode: "24941", city: "Flensburg" } });
  const customer = await dbInternal.customer.create({ data: { orgId: org.id, name: `${name} Kunde`, addressLine1: "X 1", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } });
  return { orgId: org.id, customerId: customer.id };
}

function inListSizes(calls: unknown[][]): number[] {
  const sizes: number[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (k === "in" && Array.isArray(val)) sizes.push(val.length);
        else walk(val);
      }
    }
  };
  for (const c of calls) walk(c[0]);
  return sizes;
}

describe("Index ohne Obergrenze (Phase 17c, Task 5)", () => {
  it("5.001 Relationen: Index wird gebaut, Tabs liefern Zahlen, echte Angebote behalten ihren Zustand", async () => {
    const { orgId: o, customerId: c } = await newOrg("C17T5 Ueberlast");
    const fillers = Array.from({ length: 5_001 }, (_, i) => ({
      orgId: o,
      fromType: "QUOTE",
      toType: "INVOICE",
      relationType: "CONVERTED_TO",
      fromId: `c17t5-filler-q-${i}`,
      toId: `c17t5-filler-i-${i}`,
    }));
    for (const p of part(fillers, 1_000)) await dbInternal.documentRelation.createMany({ data: p });

    const mk = async (id: string, gross: number) =>
      dbInternal.quote.create({ data: { id, orgId: o, customerId: c, status: "SENT", issueDate: new Date(START17), grossTotalCents: gross } });
    const full = await mk("c17t5-full", 10_000);
    const partial = await mk("c17t5-partial", 10_000);
    const none = await mk("c17t5-none", 10_000);
    await dbInternal.invoice.create({ data: { id: "c17t5-inv-full", orgId: o, customerId: c, status: "FINALIZED", grossTotalCents: 10_000 } });
    await dbInternal.invoice.create({ data: { id: "c17t5-inv-part", orgId: o, customerId: c, type: "PARTIAL", status: "FINALIZED", grossTotalCents: 3_000 } });
    await dbInternal.documentRelation.createMany({
      data: [
        { orgId: o, fromType: "QUOTE", toType: "INVOICE", relationType: "CONVERTED_TO", fromId: full.id, toId: "c17t5-inv-full" },
        { orgId: o, fromType: "INVOICE", toType: "QUOTE", relationType: "PARTIAL_OF", fromId: "c17t5-inv-part", toId: partial.id },
      ],
    });

    const index = await billingStateIndex(o);
    expect(index.states.get(full.id)).toBe("FULL");
    expect(index.states.get(partial.id)).toBe("PARTIAL");
    expect(index.states.get(none.id) ?? "NONE").toBe("NONE");

    const counts = await quoteStatusTabCounts(o, {}, FIX_DATE);
    expect(counts.billed).toBe(1);
    expect(counts["partially-billed"]).toBe(1);
  }, 120_000);

  it("1.500 voll abgerechnete Angebote: Tab, Liste, Tag-Schnittmenge, Org-Scope, Abfragegroesse", async () => {
    const { orgId: o, customerId: c } = await newOrg("C17T5 Gross");
    const other = await newOrg("C17T5 Fremd");
    const N = 1_500;
    const ids = Array.from({ length: N }, (_, i) => `c17t5-big-${String(i).padStart(4, "0")}`);
    const rows = ids.map((id, i) => ({ id, i }));
    for (const p of part(rows, 500)) {
      await dbInternal.quote.createMany({ data: p.map(({ id, i }) => ({ id, orgId: o, customerId: c, status: "SENT", issueDate: new Date(START17 + (i % 200) * DAY), grossTotalCents: 1_000 })) });
      await dbInternal.invoice.createMany({ data: p.map(({ id }) => ({ id: `${id}-inv`, orgId: o, customerId: c, status: "FINALIZED", grossTotalCents: 1_000 })) });
      await dbInternal.documentRelation.createMany({
        data: p.map(({ id }) => ({ orgId: o, fromType: "QUOTE", toType: "INVOICE", relationType: "CONVERTED_TO", fromId: id, toId: `${id}-inv` })),
      });
    }
    // Drei Angebote OHNE Rechnung in dieser Org; die fremde Org hat Relationen und aktive
    // Rechnungen auf genau diese Ids — sie duerfen deren Zustand nicht veraendern.
    const noneIds = ["c17t5-none-a", "c17t5-none-b", "c17t5-none-c"];
    await dbInternal.quote.createMany({ data: noneIds.map((id) => ({ id, orgId: o, customerId: c, status: "SENT", issueDate: new Date(START17), grossTotalCents: 1_000 })) });
    await dbInternal.invoice.createMany({ data: noneIds.map((id) => ({ id: `${id}-inv`, orgId: other.orgId, customerId: other.customerId, status: "FINALIZED", grossTotalCents: 1_000 })) });
    await dbInternal.documentRelation.createMany({
      data: noneIds.map((id) => ({ orgId: other.orgId, fromType: "QUOTE", toType: "INVOICE", relationType: "CONVERTED_TO", fromId: id, toId: `${id}-inv` })),
    });
    const tag = await dbInternal.tag.create({ data: { orgId: o, name: "C17T5", color: "#123456" } });
    const tagged = ids.slice(0, 300);
    await dbInternal.documentTag.createMany({ data: tagged.map((docId) => ({ orgId: o, tagId: tag.id, docType: "QUOTE", docId })) });

    const spies = [
      vi.spyOn(dbInternal.invoice, "findMany"),
      vi.spyOn(dbInternal.quote, "findMany"),
      vi.spyOn(dbInternal.quoteLine, "findMany"),
      vi.spyOn(dbInternal.invoiceLine, "groupBy"),
    ];

    const counts = await quoteStatusTabCounts(o, {}, FIX_DATE);
    expect(counts.billed).toBe(N);
    expect(counts["partially-billed"]).toBe(0);
    expect((await billingStateIndex(o)).states.has(noneIds[0])).toBe(false);

    const billed = await billingFilterIds(o, "billed");
    expect(billed).toHaveLength(N);
    const ref = [...rows].sort((a, b) => (b.i % 200) - (a.i % 200) || (a.id < b.id ? -1 : 1));
    const first = await listQuotes(o, { limit: 50 }, FIX_DATE, { ids: billed });
    expect(first.total).toBe(N);
    expect(first.rows.map((r) => r.id)).toEqual(ref.slice(0, 50).map((r) => r.id));
    const last = await listQuotes(o, { limit: 50, offset: N - 50 }, FIX_DATE, { ids: billed });
    expect(last.rows.map((r) => r.id)).toEqual(ref.slice(N - 50).map((r) => r.id));

    // Schnittmenge mit Tag-Filter.
    const both = await listQuotes(o, { tag: tag.id, limit: 200 }, FIX_DATE, { ids: billed });
    expect(both.total).toBe(300);
    expect(new Set(both.rows.map((r) => r.id)).size).toBe(200);
    expect((await quoteStatusTabCounts(o, { tag: tag.id }, FIX_DATE)).billed).toBe(300);

    const sizes = spies.flatMap((s) => inListSizes(s.mock.calls));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1_000);
    spies.forEach((s) => s.mockRestore());
  }, 120_000);
});
