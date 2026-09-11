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
import { listInvoices } from "@/domain/invoice/list";
import { listQuotes, listDeliveryNotes } from "@/domain/document/list";
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
});
