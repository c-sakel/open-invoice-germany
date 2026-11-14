/**
 * Phase 18d, Task 2 — Abgleich per updatedSince + Cursor in den Listenfunktionen.
 * Eigenes Jahr: 2190. Die Zeitstempel werden im Test-Setup ueber den ungeschuetzten Client
 * (dbInternal, ausserhalb der Domain) gesetzt.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { listInvoices } from "@/domain/invoice/list";
import { createBusinessDocument } from "@/domain/document/create";
import { listQuotes, listDeliveryNotes } from "@/domain/document/list";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { listContactsApi } from "@/domain/customer/list";
import { updateCustomer } from "@/domain/customer/save";
import { listProductsApi } from "@/domain/product/list";
import { createProduct } from "@/domain/product/save";
import { saveTag } from "@/domain/tag/manage";
import { tagDocument } from "@/domain/tag/assign";
import { recordPaymentSchema, type CreateInvoiceInput, type CreateDocumentInput, type CreateDeliveryNoteInput } from "@/schemas";

const NOW = new Date(Date.UTC(2190, 5, 15, 10, 0, 0));
const T1 = new Date("2190-03-01T09:00:00.000Z");
const T2 = new Date("2190-03-01T09:00:00.500Z");
const T3 = new Date("2190-03-02T09:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let customerId: string;

function line(description: string) {
  return { description, quantityMilli: 1000, unit: "HUR" as const, unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
}

async function newOrg(name: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Abgleichweg 1", postalCode: "24941", city: "Flensburg", vatId: "DE111222333", taxNumber: "21/555/44443" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await saveDocumentSettings(org.id, { viesCheckOnFinalize: false });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: `${name} Kunde`, addressLine1: "Ringstr. 4", postalCode: "24939", city: "Flensburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: customer.id };
}

async function draftInvoice(org: string, customer: string, description: string) {
  const input = { customerId: customer, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, lines: [line(description)] } as CreateInvoiceInput;
  return createDraftInvoice(org, input, { now: NOW });
}

/** Drei gleiche (T1) und zwei verschiedene (T2, T3) Zeitstempel, in Reihenfolge der Ids unabhaengig. */
const STAMPS = [T1, T1, T2, T1, T3];

/** Seitenweise lesen; liefert die Ids in Lieferreihenfolge und die Seitenzahl. */
async function drain(
  fn: (filter: Record<string, unknown>) => Promise<{ rows: Array<{ id: string }>; nextCursor?: string | null }>,
  filter: Record<string, unknown>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const res = await fn({ ...filter, ...(cursor ? { cursor } : {}) });
    pages++;
    ids.push(...res.rows.map((r) => r.id));
    expect(res.nextCursor).not.toBeUndefined();
    if (res.nextCursor === null || res.nextCursor === undefined) break;
    cursor = res.nextCursor;
    if (pages > 20) throw new Error("Endlosschleife");
  }
  return { ids, pages };
}

function expectSyncOrder(ids: string[], stamps: Map<string, Date>) {
  const sorted = [...ids].sort((a, b) => {
    const d = stamps.get(a)!.getTime() - stamps.get(b)!.getTime();
    return d !== 0 ? d : a < b ? -1 : 1;
  });
  expect(ids).toEqual(sorted);
}

beforeAll(async () => {
  ({ orgId, customerId } = await newOrg("Abgleich Test GmbH"));
  ({ orgId: otherOrgId } = await newOrg("Abgleich Fremd GmbH"));
});

describe("listInvoices im Abgleich", () => {
  const stamps = new Map<string, Date>();
  const invoiceIds: string[] = [];
  let otherCustomerId: string;
  let tagId: string;

  beforeAll(async () => {
    otherCustomerId = (
      await dbInternal.customer.create({ data: { orgId, name: "Zweiter Kunde", addressLine1: "Weg 2", postalCode: "24939", city: "Flensburg", type: "BUSINESS" } })
    ).id;
    for (let i = 0; i < STAMPS.length; i++) {
      const inv = await draftInvoice(orgId, i === 4 ? otherCustomerId : customerId, `Abgleich ${i}`);
      await dbInternal.invoice.update({ where: { id: inv.id }, data: { updatedAt: STAMPS[i] } });
      invoiceIds.push(inv.id);
      stamps.set(inv.id, STAMPS[i]);
    }
    tagId = (await saveTag(orgId, null, { name: "abgleich-tag" })).id;
    for (const i of [0, 2, 4]) await tagDocument(orgId, tagId, { docType: "INVOICE", docId: invoiceIds[i] });
  });

  it("liefert alle Datensaetze genau einmal in updatedAt/id-Ordnung, letzte Seite ohne Cursor", async () => {
    const { ids, pages } = await drain((f) => listInvoices(orgId, f), { updatedSince: "2190-01-01T00:00:00Z", limit: 2 });
    expect(pages).toBe(3);
    expect([...ids].sort()).toEqual([...invoiceIds].sort());
    expectSyncOrder(ids, stamps);
  });

  it("total bleibt ueber die Seiten stabil, offset ist 0", async () => {
    const first = await listInvoices(orgId, { updatedSince: "2190-01-01T00:00:00Z", limit: 2 });
    const second = await listInvoices(orgId, { updatedSince: "2190-01-01T00:00:00Z", limit: 2, cursor: first.nextCursor });
    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    expect(second.offset).toBe(0);
  });

  it("updatedSince genau auf einem Zeitstempel schliesst ihn ein; +01:00 entspricht Z", async () => {
    const atT3 = await listInvoices(orgId, { updatedSince: T3.toISOString(), limit: 50 });
    expect(atT3.rows.map((r) => r.id)).toEqual([invoiceIds[4]]);
    const viaZ = await listInvoices(orgId, { updatedSince: "2190-03-01T09:00:00.000Z", limit: 50 });
    const viaOffset = await listInvoices(orgId, { updatedSince: "2190-03-01T10:00:00.000+01:00", limit: 50 });
    expect(viaOffset.rows.map((r) => r.id)).toEqual(viaZ.rows.map((r) => r.id));
    expect(viaZ.rows).toHaveLength(5);
  });

  it("kombiniert mit status und customerId", async () => {
    const draft = await drain((f) => listInvoices(orgId, f), { updatedSince: "2190-01-01T00:00:00Z", status: "draft", limit: 2 });
    expect(draft.ids).toHaveLength(5);
    const paid = await listInvoices(orgId, { updatedSince: "2190-01-01T00:00:00Z", status: "paid" });
    expect(paid.rows).toHaveLength(0);
    expect(paid.nextCursor).toBeNull();
    const byCustomer = await drain((f) => listInvoices(orgId, f), { updatedSince: "2190-01-01T00:00:00Z", customerId: otherCustomerId, limit: 1 });
    expect(byCustomer.ids).toEqual([invoiceIds[4]]);
  });

  it("kombiniert mit Tag-Filter: gleiche Ordnung, nur die drei", async () => {
    const { ids } = await drain((f) => listInvoices(orgId, f), { updatedSince: "2190-01-01T00:00:00Z", tag: tagId, limit: 2 });
    expect([...ids].sort()).toEqual([invoiceIds[0], invoiceIds[2], invoiceIds[4]].sort());
    expectSyncOrder(ids, stamps);
  });

  it("ohne updatedSince unveraendert: issueDate_desc, kein nextCursor-Schluessel", async () => {
    const res = await listInvoices(orgId, { limit: 50 });
    expect(Object.keys(res).sort()).toEqual(["limit", "offset", "rows", "total"]);
    expect(res.rows).toHaveLength(5);
  });

  it("Fremde Org: Cursor aus Org A liefert in Org B nichts aus A", async () => {
    const page = await listInvoices(orgId, { updatedSince: "2190-01-01T00:00:00Z", limit: 1 });
    const foreign = await listInvoices(otherOrgId, { updatedSince: "2190-01-01T00:00:00Z", limit: 50, cursor: page.nextCursor });
    expect(foreign.rows).toHaveLength(0);
    expect(foreign.total).toBe(0);
  });

  it("Querregeln: offset und sort mit updatedSince sind Validierungsfehler", async () => {
    await expect(listInvoices(orgId, { updatedSince: "2190-01-01T00:00:00Z", offset: 1 })).rejects.toThrow();
    await expect(listInvoices(orgId, { updatedSince: "2190-01-01T00:00:00Z", sort: "gross_desc" })).rejects.toThrow();
    await expect(listInvoices(orgId, { cursor: "v1.abc" })).rejects.toThrow();
  });
});

describe("Quotes, Lieferscheine, Kontakte, Produkte im Abgleich", () => {
  it("listQuotes: ANGEBOT und AUFTRAGSBESTAETIGUNG getrennt ueber kind", async () => {
    const stamps = new Map<string, Date>();
    const byKind: Record<string, string[]> = { ANGEBOT: [], AUFTRAGSBESTAETIGUNG: [] };
    const plan: Array<[string, Date]> = [["ANGEBOT", T1], ["ANGEBOT", T1], ["ANGEBOT", T2], ["AUFTRAGSBESTAETIGUNG", T1], ["AUFTRAGSBESTAETIGUNG", T3]];
    for (const [kind, stamp] of plan) {
      const q = await createBusinessDocument(orgId, { kind, customerId, taxScheme: "REGULAR", currency: "EUR", lines: [line("Abgleich Beleg")] } as CreateDocumentInput);
      await dbInternal.quote.update({ where: { id: q.id }, data: { updatedAt: stamp } });
      stamps.set(q.id, stamp);
      byKind[kind].push(q.id);
    }
    for (const kind of ["ANGEBOT", "AUFTRAGSBESTAETIGUNG"] as const) {
      const { ids } = await drain((f) => listQuotes(orgId, f), { updatedSince: "2190-01-01T00:00:00Z", kind, limit: 1 });
      expect([...ids].sort()).toEqual([...byKind[kind]].sort());
      expectSyncOrder(ids, stamps);
    }
  });

  it("listDeliveryNotes", async () => {
    const stamps = new Map<string, Date>();
    const all: string[] = [];
    for (const stamp of [T1, T1, T2]) {
      const dn = await createDeliveryNote(
        orgId,
        { customerId, deliveryDate: NOW, lines: [line("Abgleich Lieferschein")] } as unknown as CreateDeliveryNoteInput,
        { actor: "tester", now: NOW },
      );
      await dbInternal.deliveryNote.update({ where: { id: dn.id }, data: { updatedAt: stamp } });
      stamps.set(dn.id, stamp);
      all.push(dn.id);
    }
    const { ids } = await drain((f) => listDeliveryNotes(orgId, f), { updatedSince: "2190-01-01T00:00:00Z", limit: 1 });
    expect([...ids].sort()).toEqual([...all].sort());
    expectSyncOrder(ids, stamps);
  });

  it("listContactsApi (frische Org, inkl. archivierte)", async () => {
    const o = await newOrg("Abgleich Kontakte GmbH");
    const extra = await Promise.all(
      [T1, T2].map((stamp, i) =>
        dbInternal.customer.create({ data: { orgId: o.orgId, name: `Kontakt ${i}`, addressLine1: "Weg 3", postalCode: "24939", city: "Flensburg", type: "BUSINESS", updatedAt: stamp } }),
      ),
    );
    await dbInternal.customer.update({ where: { id: o.customerId }, data: { updatedAt: T1 } });
    const stamps = new Map<string, Date>([[o.customerId, T1], [extra[0].id, T1], [extra[1].id, T2]]);
    const { ids } = await drain((f) => listContactsApi(o.orgId, f), { updatedSince: "2190-01-01T00:00:00Z", limit: 1 });
    expect(ids).toHaveLength(3);
    expectSyncOrder(ids, stamps);
    await dbInternal.customer.update({ where: { id: extra[1].id }, data: { isArchived: true, updatedAt: T2 } });
    const without = await listContactsApi(o.orgId, { updatedSince: "2190-01-01T00:00:00Z" });
    expect(without.rows).toHaveLength(2);
    const withArchived = await listContactsApi(o.orgId, { updatedSince: "2190-01-01T00:00:00Z", includeArchived: true });
    expect(withArchived.rows).toHaveLength(3);
  });

  it("listProductsApi", async () => {
    const o = await newOrg("Abgleich Produkte GmbH");
    const stamps = new Map<string, Date>();
    for (const [i, stamp] of [T1, T1, T2].entries()) {
      const p = await createProduct(o.orgId, { name: `Abgleich Produkt ${i}`, netPriceCents: 1000 });
      await dbInternal.product.update({ where: { id: p.id }, data: { updatedAt: stamp } });
      stamps.set(p.id, stamp);
    }
    const { ids } = await drain((f) => listProductsApi(o.orgId, f), { updatedSince: "2190-01-01T00:00:00Z", limit: 1 });
    expect(ids).toHaveLength(3);
    expectSyncOrder(ids, stamps);
    const plain = await listProductsApi(o.orgId, {});
    expect(Object.keys(plain).sort()).toEqual(["limit", "offset", "rows", "total"]);
  });
});

describe("updatedAt folgt Aenderungen", () => {
  // Vergangenheit, weil updatedAt von der Datenbank-Schicht mit der echten Uhr gesetzt wird.
  const OLD = new Date("2001-01-01T00:00:00.000Z");

  async function invUpdatedAt(id: string): Promise<Date> {
    return (await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt;
  }
  async function reset(id: string) {
    await dbInternal.invoice.update({ where: { id }, data: { updatedAt: OLD } });
  }

  it("festschreiben, Zahlung, Gegenbuchung, Storno und Kundenaenderung erhoehen updatedAt", async () => {
    const draft = await draftInvoice(orgId, customerId, "Fortschreibung");
    await reset(draft.id);
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    expect(+(await invUpdatedAt(fin.id))).toBeGreaterThan(+OLD);

    await reset(fin.id);
    const pay = await recordPayment(fin.id, recordPaymentSchema.parse({ amountCents: 1000, method: "TRANSFER", paidAt: NOW }));
    expect(+(await invUpdatedAt(fin.id))).toBeGreaterThan(+OLD);

    await reset(fin.id);
    await reversePayment(pay.recorded.id, { reason: "Fehlbuchung" }, { actor: "tester", orgId, now: NOW });
    expect(+(await invUpdatedAt(fin.id))).toBeGreaterThan(+OLD);

    await reset(fin.id);
    await cancelInvoice(fin.id, { orgId, now: NOW });
    expect(+(await invUpdatedAt(fin.id))).toBeGreaterThan(+OLD);

    await dbInternal.customer.update({ where: { id: customerId }, data: { updatedAt: OLD } });
    await updateCustomer(orgId, customerId, { phone: "0461 123456" });
    const c = await dbInternal.customer.findUniqueOrThrow({ where: { id: customerId }, select: { updatedAt: true } });
    expect(+c.updatedAt).toBeGreaterThan(+OLD);
  });
});
