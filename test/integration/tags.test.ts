/**
 * Phase 13d, Task 2 — Tag-Domain (src/domain/tag/{manage,assign,list}.ts).
 *
 * Kernpunkt (Ruling, koordinator-nachtrag.md): Tags sind Metadaten, KEIN GoBD-
 * Belegbestandteil — setzen/entfernen ist auch an festgeschriebenen Rechnungen erlaubt,
 * schreibt NIE die ChangeLog-Hash-Kette (nur ActivityLog) und ruehrt die Rechnung selbst
 * nicht an (kein invoice-Schreibvorgang, Guard in src/lib/db.ts bleibt unberuehrt).
 *
 * Testjahr 2090 (grep "20[0-9]{2}" ueber test/integration/*.test.ts, Testjahr-Konvention
 * — Belegnummern sind instanzweit eindeutig, nicht je Org). EIN gemeinsamer Org fuer die
 * meisten Tests (Muster activity-timeline.test.ts), eine zweite Org (orgB) nur fuer den
 * Isolationstest.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import type { Tag } from "@/generated/prisma/client";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createInvoiceSchema, type CreateInvoiceInput, type CreateDocumentInput } from "@/schemas";
import { listTags, saveTag, deleteTag, TagNotFoundError, TagNameConflictError } from "@/domain/tag/manage";
import { tagDocument, untagDocument } from "@/domain/tag/assign";
import { tagsForDocuments, docIdsForTag } from "@/domain/tag/list";
import { NotFoundError } from "@/domain/errors";
import { RelationError } from "@/domain/relations";

const FIX_DATE = new Date("2090-06-09T10:00:00.000Z");

let orgId: string;
let orgB: string;
let customerId: string;
let tag: Tag; // "Wartung", slate — geteilter Fixture-Tag (beforeAll)
let n = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Tag Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999997", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde GmbH", addressLine1: "X", postalCode: "1", city: "X" },
  });
  orgB = other.id;

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;

  tag = await saveTag(orgId, null, { name: "Wartung" });
});

function invoiceInput(extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  n += 1;
  return createInvoiceSchema.parse({
    customerId,
    lines: [{ description: `Position ${n}`, quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 }],
    ...extra,
  } as CreateInvoiceInput);
}

async function draftInvoice() {
  return createDraftInvoice(orgId, invoiceInput(), { now: FIX_DATE });
}

async function draftQuote() {
  return createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    } as CreateDocumentInput,
    { now: FIX_DATE },
  );
}

async function draftDeliveryNote() {
  return createDeliveryNote(orgId, { customerId, lines: [{ description: "Ware", quantityMilli: 1000, unitNetPriceCents: 0, taxRate: 19 }] }, { now: FIX_DATE });
}

describe("tagDocument/untagDocument", () => {
  it("Tag an einer FESTGESCHRIEBENEN Rechnung setzen und entfernen ist erlaubt", async () => {
    const draft = await draftInvoice();
    const inv = await finalizeInvoice(draft.id, { now: FIX_DATE });
    const before = await dbInternal.changeLog.count({ where: { orgId } });
    const stamp = (await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { updatedAt: true } })).updatedAt;

    await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: inv.id });
    await untagDocument(orgId, tag.id, { docType: "INVOICE", docId: inv.id });

    expect(await dbInternal.changeLog.count({ where: { orgId } })).toBe(before); // kein ChangeLog
    const acts = await dbInternal.activityLog.findMany({ where: { orgId, entityId: inv.id, type: { in: ["TAG_ADDED", "TAG_REMOVED"] } } });
    expect(acts).toHaveLength(2); // ActivityLog +2
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { updatedAt: true } });
    expect(after.updatedAt.getTime()).toBe(stamp.getTime()); // Beleg unberuehrt
  });

  it("tag_document ist idempotent, Tag-Loeschen entfernt die Zuordnungen", async () => {
    const localTag = await saveTag(orgId, null, { name: `Idempotenz-${n}`, color: "rose" });
    const draft = await draftInvoice();
    const ref = { docType: "INVOICE" as const, docId: draft.id };

    expect((await tagDocument(orgId, localTag.id, ref)).created).toBe(true);
    expect((await tagDocument(orgId, localTag.id, ref)).created).toBe(false);
    expect((await deleteTag(orgId, localTag.id)).removedAssignments).toBe(1);
    expect(await dbInternal.documentTag.count({ where: { orgId, tagId: localTag.id } })).toBe(0);
  });

  it("untagDocument ist idempotent: entfernt keine bestehende Zuordnung -> removed: false", async () => {
    const draft = await draftInvoice();
    const result = await untagDocument(orgId, tag.id, { docType: "INVOICE", docId: draft.id });
    expect(result).toEqual({ removed: false });
  });

  it("wirft NotFoundError fuer einen unbekannten oder fremden Tag", async () => {
    const draft = await draftInvoice();
    await expect(tagDocument(orgId, "unbekannt", { docType: "INVOICE", docId: draft.id })).rejects.toBeInstanceOf(NotFoundError);
    // Ein Tag aus orgB ist aus Sicht von orgId unbekannt (Org-Isolation).
    const foreignTag = await saveTag(orgB, null, { name: "Fremd" });
    await expect(tagDocument(orgId, foreignTag.id, { docType: "INVOICE", docId: draft.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("wirft RelationError fuer einen unbekannten Beleg (assertDocExists)", async () => {
    await expect(tagDocument(orgId, tag.id, { docType: "INVOICE", docId: "unbekannt" })).rejects.toBeInstanceOf(RelationError);
  });

  it("funktioniert fuer QUOTE und DELIVERY_NOTE (polymorph, Org-Isolation ueber alle drei docTypes)", async () => {
    const quote = await draftQuote();
    const note = await draftDeliveryNote();

    await tagDocument(orgId, tag.id, { docType: "QUOTE", docId: quote.id });
    await tagDocument(orgId, tag.id, { docType: "DELIVERY_NOTE", docId: note.id });

    const map = await tagsForDocuments(orgId, "QUOTE", [quote.id]);
    expect(map.get(quote.id)?.map((t) => t.id)).toContain(tag.id);
    const noteMap = await tagsForDocuments(orgId, "DELIVERY_NOTE", [note.id]);
    expect(noteMap.get(note.id)?.map((t) => t.id)).toContain(tag.id);

    await untagDocument(orgId, tag.id, { docType: "QUOTE", docId: quote.id });
    await untagDocument(orgId, tag.id, { docType: "DELIVERY_NOTE", docId: note.id });
  });
});

describe("tag/list", () => {
  it("docIdsForTag liefert genau die Belege, die den Tag tragen", async () => {
    const localTag = await saveTag(orgId, null, { name: `Filter-${n}`, color: "sky" });
    const a = await draftInvoice();
    const b = await draftInvoice();
    const c = await draftInvoice();
    await tagDocument(orgId, localTag.id, { docType: "INVOICE", docId: a.id });
    await tagDocument(orgId, localTag.id, { docType: "INVOICE", docId: b.id });

    const ids = await docIdsForTag(orgId, localTag.id, "INVOICE");
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
    expect(ids).not.toContain(c.id);
  });

  it("tagsForDocuments liefert eine leere Map fuer eine leere docIds-Liste, ohne Fehler", async () => {
    expect(await tagsForDocuments(orgId, "INVOICE", [])).toEqual(new Map());
  });
});

describe("Tag-Verwaltung (manage.ts)", () => {
  it("listTags liefert die Zuordnungszahl je Tag mit", async () => {
    const localTag = await saveTag(orgId, null, { name: `Zaehler-${n}`, color: "emerald" });
    const a = await draftInvoice();
    const b = await draftInvoice();
    await tagDocument(orgId, localTag.id, { docType: "INVOICE", docId: a.id });
    await tagDocument(orgId, localTag.id, { docType: "INVOICE", docId: b.id });

    const rows = await listTags(orgId);
    const row = rows.find((r) => r.id === localTag.id);
    expect(row?.documentCount).toBe(2);
  });

  it("aendert Name/Farbe eines bestehenden Tags (id gesetzt)", async () => {
    const localTag = await saveTag(orgId, null, { name: `Umbenennen-${n}`, color: "slate" });
    const updated = await saveTag(orgId, localTag.id, { name: `Umbenannt-${n}`, color: "violet" });
    expect(updated).toMatchObject({ id: localTag.id, name: `Umbenannt-${n}`, color: "violet" });
  });

  it("wirft TagNotFoundError bei unbekannter/fremder id", async () => {
    await expect(saveTag(orgId, "unbekannt", { name: "X" })).rejects.toBeInstanceOf(TagNotFoundError);
    await expect(deleteTag(orgId, "unbekannt")).rejects.toBeInstanceOf(TagNotFoundError);
  });

  it("gleicher Name in zwei Organisationen ok, doppelt in einer nicht", async () => {
    await saveTag(orgB, null, { name: "Wartung" }); // ok, andere Org
    await expect(saveTag(orgId, null, { name: "Wartung" })).rejects.toBeInstanceOf(TagNameConflictError);
  });

  it("deleteTag ohne Zuordnungen liefert removedAssignments: 0", async () => {
    const localTag = await saveTag(orgId, null, { name: `Leer-${n}`, color: "indigo" });
    expect(await deleteTag(orgId, localTag.id)).toEqual({ removedAssignments: 0 });
  });

  it("deleteTag schreibt einen ActivityLog-Eintrag TAG_DELETED (entityType TAG, entityId = Tag.id)", async () => {
    const name = `Loeschen-${n}`;
    const localTag = await saveTag(orgId, null, { name, color: "stone" });
    const draft = await draftInvoice();
    await tagDocument(orgId, localTag.id, { docType: "INVOICE", docId: draft.id });

    await deleteTag(orgId, localTag.id, "tester@example.com");

    const entries = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "TAG", entityId: localTag.id, type: "TAG_DELETED" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "tester@example.com" });
    expect(JSON.parse(entries[0].dataJson ?? "{}")).toMatchObject({ name, removedAssignments: 1 });
  });
});
