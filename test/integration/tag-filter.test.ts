/**
 * Phase 13d, Task 4 (task-4-brief.md, Step 1) — Tag-Filter der drei Listen. `tag` filtert
 * ALS EINE ZUSAETZLICHE `and`-Bedingung in listInvoices/listQuotes/listDeliveryNotes
 * (`docIdsForTag`, src/domain/tag/list.ts): eine leere Zuordnungsmenge ergibt bewusst eine
 * leere Ergebnisliste (`id: { in: [] }`), NIE einen ignorierten Filter. `tag` muss
 * zusaetzlich die Detailseite ueberleben (`ALLOWED_KEYS`, src/domain/document/neighbors.ts).
 *
 * Testjahr 2091 (Testjahr-Konvention, grep "20[0-9]{2}" ueber test/integration/*.test.ts —
 * bislang unbenutzt).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createInvoiceSchema, type CreateInvoiceInput, type CreateDocumentInput } from "@/schemas";
import { listInvoices, invoiceStatusTabCounts, invoiceListHeadline } from "@/domain/invoice/list";
import { listQuotes, listDeliveryNotes, quoteStatusTabCounts, quoteListHeadline, deliveryNoteStatusTabCounts, deliveryNoteListHeadline } from "@/domain/document/list";
import { saveTag } from "@/domain/tag/manage";
import { tagDocument } from "@/domain/tag/assign";
import { ALLOWED_KEYS } from "@/domain/document/neighbors";

const FIX_DATE = new Date("2091-06-09T10:00:00.000Z");

let orgId: string;
let orgB: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Tag-Filter Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999995", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const other = await dbInternal.organization.create({ data: { legalName: "Fremde GmbH", addressLine1: "X", postalCode: "1", city: "X" } });
  orgB = other.id;
  await ensureOrgMasterdata(dbInternal, orgB);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
});

let n = 0;
function uniqueDesc(): string {
  n += 1;
  return `Position ${n}`;
}

async function draftInvoice() {
  return createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      lines: [{ description: uniqueDesc(), quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 }],
    } as CreateInvoiceInput),
    { now: FIX_DATE },
  );
}

async function draftQuote() {
  return createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [{ lineType: "ITEM", description: uniqueDesc(), quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    } as CreateDocumentInput,
    { now: FIX_DATE },
  );
}

async function draftDeliveryNote() {
  return createDeliveryNote(orgId, { customerId, lines: [{ description: uniqueDesc(), quantityMilli: 1000, unitNetPriceCents: 0, taxRate: 19 }] }, { now: FIX_DATE });
}

describe("Tag-Filter der Listen", () => {
  it("?tag=<id> liefert genau die zugeordneten Rechnungen, fremde Organisation nie, ohne Zuordnung leer statt ungefiltert", async () => {
    const tag = await saveTag(orgId, null, { name: "Filter-A" });
    const leererTag = await saveTag(orgId, null, { name: "Filter-Leer" });
    const a = await draftInvoice();
    await draftInvoice(); // b: bewusst NICHT getaggt — darf im gefilterten Ergebnis nicht auftauchen.

    await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: a.id });

    expect((await listInvoices(orgId, { tag: tag.id })).rows.map((r) => r.id)).toEqual([a.id]);
    expect((await listInvoices(orgB, { tag: tag.id })).rows).toHaveLength(0);
    expect((await listInvoices(orgId, { tag: leererTag.id })).rows).toHaveLength(0);
  });

  it("filtert Angebote (listQuotes) und Lieferscheine (listDeliveryNotes) ebenso", async () => {
    const tag = await saveTag(orgId, null, { name: "Filter-B" });
    const quote = await draftQuote();
    await draftQuote(); // ungetaggt
    const note = await draftDeliveryNote();
    await draftDeliveryNote(); // ungetaggt

    await tagDocument(orgId, tag.id, { docType: "QUOTE", docId: quote.id });
    await tagDocument(orgId, tag.id, { docType: "DELIVERY_NOTE", docId: note.id });

    expect((await listQuotes(orgId, { tag: tag.id })).rows.map((r) => r.id)).toEqual([quote.id]);
    expect((await listDeliveryNotes(orgId, { tag: tag.id })).rows.map((r) => r.id)).toEqual([note.id]);
  });

  it("tag ueberlebt den Sprung Detailseite -> Zurueck zur Liste (ALLOWED_KEYS)", () => {
    expect(ALLOWED_KEYS).toContain("tag");
  });

  // Fix-Welle 1 (must 1, Koordinator-Ruling): Tab-Zaehler UND Kopfkennzahl muessen bei
  // aktivem Tag-Filter dieselbe Zahl zeigen wie die (gefilterte) Liste — vor dieser
  // Fix-Welle ignorierten invoiceStatusTabCounts/invoiceListHeadline (analog bei Angeboten/
  // Lieferscheinen) `filter.tag`, siehe final-review.md must 1.
  it("Tag-Filter: Tab-Zaehler UND Kopfkennzahl stimmen bei Rechnungen mit der gefilterten Liste ueberein", async () => {
    const tag = await saveTag(orgId, null, { name: "Filter-Counts-Invoice" });
    const tagged = await draftInvoice();
    await draftInvoice(); // ungetaggt — darf weder in den Tabs noch in der Kennzahl mitzaehlen.
    await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: tagged.id });

    const [list, tabs, headline] = await Promise.all([
      listInvoices(orgId, { tag: tag.id }),
      invoiceStatusTabCounts(orgId, { tag: tag.id }),
      invoiceListHeadline(orgId, { tag: tag.id }),
    ]);

    expect(list.rows.map((r) => r.id)).toEqual([tagged.id]);
    expect(list.total).toBe(1);
    expect(tabs.all).toBe(1);
    expect(tabs.draft).toBe(1); // draftInvoice() legt den Beleg als DRAFT an.
    expect(headline.count).toBe(1);
  });

  it("Tag-Filter: Tab-Zaehler UND Kopfkennzahl stimmen bei Angeboten mit der gefilterten Liste ueberein", async () => {
    const tag = await saveTag(orgId, null, { name: "Filter-Counts-Quote" });
    const tagged = await draftQuote();
    await draftQuote(); // ungetaggt
    await tagDocument(orgId, tag.id, { docType: "QUOTE", docId: tagged.id });

    const [list, tabs, headline] = await Promise.all([
      listQuotes(orgId, { tag: tag.id }),
      quoteStatusTabCounts(orgId, { tag: tag.id }),
      quoteListHeadline(orgId, { tag: tag.id }),
    ]);

    expect(list.rows.map((r) => r.id)).toEqual([tagged.id]);
    expect(list.total).toBe(1);
    expect(tabs.all).toBe(1);
    expect(tabs.DRAFT).toBe(1);
    expect(headline.count).toBe(1);
  });

  it("Tag-Filter: Tab-Zaehler UND Kopfkennzahl stimmen bei Lieferscheinen mit der gefilterten Liste ueberein", async () => {
    const tag = await saveTag(orgId, null, { name: "Filter-Counts-DeliveryNote" });
    const tagged = await draftDeliveryNote();
    await draftDeliveryNote(); // ungetaggt
    await tagDocument(orgId, tag.id, { docType: "DELIVERY_NOTE", docId: tagged.id });

    const [list, tabs, headline] = await Promise.all([
      listDeliveryNotes(orgId, { tag: tag.id }),
      deliveryNoteStatusTabCounts(orgId, { tag: tag.id }),
      deliveryNoteListHeadline(orgId, { tag: tag.id }),
    ]);

    expect(list.rows.map((r) => r.id)).toEqual([tagged.id]);
    expect(list.total).toBe(1);
    expect(tabs.all).toBe(1);
    expect(tabs.CREATED).toBe(1); // createDeliveryNoteWithinTx vergibt sofort status=CREATED.
    expect(headline.count).toBe(1);
  });
});
