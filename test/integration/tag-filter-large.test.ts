/**
 * Phase 17c, Task 4 — Tag-Filter ohne 5.000er-Grenze: Listen, Tabs und Kennzahlen ueber
 * Id-Mengen in Bloecken (src/lib/id-filter.ts). Testjahr 2153; es entstehen nur Entwuerfe
 * ohne Nummer (kein Nummernkreis betroffen).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { dbInternal, prisma } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { listInvoices, invoiceStatusTabCounts, invoiceListHeadline } from "@/domain/invoice/list";
import { loadNeighbors } from "@/domain/document/neighbors";
import { listQuotes, listDeliveryNotes, quoteStatusTabCounts, quoteListHeadline, deliveryNoteStatusTabCounts, deliveryNoteListHeadline } from "@/domain/document/list";

const N_INV = 5_100;
const N_DOC = 1_200;
const DAY = 86_400_000;
const START = Date.UTC(2153, 0, 1);

let orgId: string;
let otherOrgId: string;
let tagId: string;
let customerId: string;
let invoiceRows: { id: string; issueDate: Date; dueDate: Date | null; grossTotalCents: number }[] = [];

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Tag-Gross GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin" } });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const other = await dbInternal.organization.create({ data: { legalName: "Fremde Tag-Gross GmbH", addressLine1: "X", postalCode: "1", city: "X" } });
  otherOrgId = other.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde Gross AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
  const tag = await dbInternal.tag.create({ data: { orgId, name: "Gross", color: "#336699" } });
  tagId = tag.id;
  const otherCustomer = await dbInternal.customer.create({ data: { orgId: otherOrgId, name: "Fremdkunde", addressLine1: "X", postalCode: "1", city: "X", type: "BUSINESS" } });
  const otherTag = await dbInternal.tag.create({ data: { orgId: otherOrgId, name: "Gross", color: "#336699" } });

  invoiceRows = Array.from({ length: N_INV }, (_, i) => ({
    id: `c17t4-inv-${String(i).padStart(5, "0")}`,
    issueDate: new Date(START + (i % 400) * DAY),
    dueDate: i % 7 === 0 ? null : new Date(START + ((i * 13) % 500) * DAY),
    grossTotalCents: 1_000 + ((i * 37) % 900),
  }));
  for (const part of chunks(invoiceRows, 500)) {
    await dbInternal.invoice.createMany({ data: part.map((r) => ({ ...r, orgId, customerId, status: "DRAFT", number: null })) });
  }
  const docIds = Array.from({ length: N_DOC }, (_, i) => `c17t4-doc-${String(i).padStart(5, "0")}`);
  for (const part of chunks(docIds.map((id, i) => ({ id, i })), 500)) {
    await dbInternal.quote.createMany({
      data: part.map(({ id, i }) => ({ id, orgId, customerId, status: "DRAFT", issueDate: new Date(START + (i % 300) * DAY), grossTotalCents: 5_000 + i })),
    });
    await dbInternal.deliveryNote.createMany({ data: part.map(({ id, i }) => ({ id: `${id}-dn`, orgId, customerId, status: "DRAFT", issueDate: new Date(START + (i % 300) * DAY) })) });
  }
  const tags = [
    ...invoiceRows.map((r) => ({ orgId, tagId, docType: "INVOICE", docId: r.id })),
    ...docIds.map((id) => ({ orgId, tagId, docType: "QUOTE", docId: id })),
    ...docIds.map((id) => ({ orgId, tagId, docType: "DELIVERY_NOTE", docId: `${id}-dn` })),
    // Fremde Org: gleicher Tag-Name, gleiche docIds -> darf nie auftauchen.
    ...invoiceRows.slice(0, 50).map((r) => ({ orgId: otherOrgId, tagId: otherTag.id, docType: "INVOICE", docId: r.id })),
  ];
  for (const part of chunks(tags, 1_000)) await dbInternal.documentTag.createMany({ data: part });
  void otherCustomer;
}, 120_000);

function byIssueDesc<T extends { id: string; issueDate: Date }>(a: T[]): T[] {
  return [...a].sort((x, y) => y.issueDate.getTime() - x.issueDate.getTime() || (x.id < y.id ? -1 : 1));
}

describe("Rechnungen mit Tag (5.100 Treffer)", () => {
  it("total, erste und letzte Seite", async () => {
    const ref = byIssueDesc(invoiceRows);
    const first = await listInvoices(orgId, { tag: tagId, limit: 50 });
    expect(first.total).toBe(N_INV);
    expect(first.rows.map((r) => r.id)).toEqual(ref.slice(0, 50).map((r) => r.id));
    const last = await listInvoices(orgId, { tag: tagId, limit: 50, offset: 5_050 });
    expect(last.rows.map((r) => r.id)).toEqual(ref.slice(5_050).map((r) => r.id));
    expect(last.rows).toHaveLength(50);
  }, 60_000);

  it("gross_desc und dueDate_asc stimmen mit der JS-Referenz ueberein (Null-Faelligkeit zuletzt)", async () => {
    const grossRef = [...invoiceRows].sort((a, b) => b.grossTotalCents - a.grossTotalCents || (a.id < b.id ? -1 : 1));
    const dueRef = [...invoiceRows].sort((a, b) => {
      if (a.dueDate === null || b.dueDate === null) return a.dueDate === b.dueDate ? (a.id < b.id ? -1 : 1) : a.dueDate === null ? 1 : -1;
      return a.dueDate.getTime() - b.dueDate.getTime() || (a.id < b.id ? -1 : 1);
    });
    for (const offset of [0, 2_500, 5_050]) {
      const g = await listInvoices(orgId, { tag: tagId, sort: "gross_desc", limit: 50, offset });
      expect(g.rows.map((r) => r.id)).toEqual(grossRef.slice(offset, offset + 50).map((r) => r.id));
      const d = await listInvoices(orgId, { tag: tagId, sort: "dueDate_asc", limit: 50, offset });
      expect(d.rows.map((r) => r.id)).toEqual(dueRef.slice(offset, offset + 50).map((r) => r.id));
    }
  }, 120_000);

  it("Tab-Zahlen und Kopfkennzahl ueber alle Treffer", async () => {
    expect((await invoiceStatusTabCounts(orgId, { tag: tagId })).all).toBe(N_INV);
    const h = await invoiceListHeadline(orgId, { tag: tagId });
    expect(h.count).toBe(N_INV);
    expect(h.grossCents).toBe(invoiceRows.reduce((s, r) => s + r.grossTotalCents, 0));
    expect(h.draftCount).toBe(N_INV);
  }, 60_000);

  it("fremde Org sieht nur ihre eigene Zuordnung, nie Treffer dieser Org", async () => {
    const r = await listInvoices(otherOrgId, { tag: tagId, limit: 50 });
    expect(r.total).toBe(0);
  });
});

describe("Angebote und Lieferscheine mit Tag (1.200 Treffer)", () => {
  it("Listen, Tabs und Kopfzahl", async () => {
    const q = await listQuotes(orgId, { tag: tagId, limit: 50, offset: 1_150 });
    expect(q.total).toBe(N_DOC);
    expect(q.rows).toHaveLength(50);
    expect((await quoteStatusTabCounts(orgId, { tag: tagId })).all).toBe(N_DOC);
    const qh = await quoteListHeadline(orgId, { tag: tagId });
    expect(qh.count).toBe(N_DOC);
    expect(qh.grossCents).toBe(Array.from({ length: N_DOC }, (_, i) => 5_000 + i).reduce((a, b) => a + b, 0));

    const d = await listDeliveryNotes(orgId, { tag: tagId, limit: 50, offset: 1_150 });
    expect(d.total).toBe(N_DOC);
    expect(d.rows).toHaveLength(50);
    expect((await deliveryNoteStatusTabCounts(orgId, { tag: tagId })).all).toBe(N_DOC);
    expect((await deliveryNoteListHeadline(orgId, { tag: tagId })).count).toBe(N_DOC);
  }, 60_000);
});

describe("Vor/Zurueck mit Tag-Menge ueber die Blockgrenze (> 900)", () => {
  async function expectNeighbors(kind: "INVOICE" | "QUOTE" | "DELIVERY_NOTE", ref: string[], positions: number[]) {
    for (const pos of positions) {
      const n = await loadNeighbors(kind, orgId, ref[pos], `tag=${tagId}`);
      expect(n.prevId, `${kind} prev @${pos}`).toBe(pos > 0 ? ref[pos - 1] : null);
      expect(n.nextId, `${kind} next @${pos}`).toBe(pos < ref.length - 1 ? ref[pos + 1] : null);
    }
  }

  it("Rechnungen (5.100 Ids, Grenze 5.000 = NEIGHBOR_LIMIT): Blockgrenzen 900/1.800", async () => {
    const ref = byIssueDesc(invoiceRows).map((r) => r.id);
    await expectNeighbors("INVOICE", ref, [0, 1, 898, 899, 900, 901, 1_799, 1_800, 4_998]);
    // Hinter der Obergrenze gibt es keine Nachbarn.
    expect(await loadNeighbors("INVOICE", orgId, ref[5_050], `tag=${tagId}`)).toMatchObject({ prevId: null, nextId: null });
  }, 60_000);

  it("Angebote und Lieferscheine (1.200 Ids): Blockgrenze 900", async () => {
    const docs = Array.from({ length: N_DOC }, (_, i) => ({ id: `c17t4-doc-${String(i).padStart(5, "0")}`, issueDate: new Date(START + (i % 300) * DAY) }));
    const ref = byIssueDesc(docs).map((r) => r.id);
    await expectNeighbors("QUOTE", ref, [0, 898, 899, 900, 901, 1_199]);
    await expectNeighbors("DELIVERY_NOTE", ref.map((id) => `${id}-dn`), [0, 898, 899, 900, 901, 1_199]);
  }, 60_000);
});

describe("Abfragegroesse", () => {
  it("keine Abfrage mit mehr als 1.000 Ids in id.in", async () => {
    const spies = [
      vi.spyOn(prisma.invoice, "findMany"),
      vi.spyOn(prisma.invoice, "count"),
      vi.spyOn(prisma.invoice, "groupBy"),
      vi.spyOn(prisma.quote, "findMany"),
      vi.spyOn(prisma.quote, "count"),
      vi.spyOn(prisma.deliveryNote, "findMany"),
      vi.spyOn(prisma.deliveryNote, "count"),
    ];
    await listInvoices(orgId, { tag: tagId, limit: 50, offset: 100 });
    await invoiceStatusTabCounts(orgId, { tag: tagId });
    await invoiceListHeadline(orgId, { tag: tagId });
    await listQuotes(orgId, { tag: tagId });
    await listDeliveryNotes(orgId, { tag: tagId });
    let seen = 0;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (k === "in" && Array.isArray(val)) {
            seen += 1;
            expect(val.length).toBeLessThanOrEqual(1_000);
          } else walk(val);
        }
      }
    };
    for (const s of spies) for (const call of s.mock.calls) walk(call[0]);
    expect(seen).toBeGreaterThan(0);
    spies.forEach((s) => s.mockRestore());
  }, 60_000);
});
