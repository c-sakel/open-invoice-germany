/**
 * Phase 17c, Task 6 — Vor/Zurueck ueber schlanke Id-Abfrage bis 5.000 Treffer. Testjahr 2154;
 * es entstehen nur Entwuerfe/Rohzeilen ohne Belegnummer (kein Nummernkreis betroffen).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { dbInternal, prisma } from "@/lib/db";
import { loadNeighbors } from "@/domain/document/neighbors";
import { listInvoiceIds } from "@/domain/invoice/list";

const DAY = 86_400_000;
const START = Date.UTC(2154, 0, 1);
const N_INV = 300;
const N_DOC = 250;

let orgId: string;
let otherOrgId: string;
let customerId: string;
let tagId: string;
let invoices: { id: string; issueDate: Date; grossTotalCents: number }[];
let quotes: { id: string; issueDate: Date }[];
let notes: { id: string; issueDate: Date }[];

const byDateDesc = <T extends { id: string; issueDate: Date }>(a: T[]): T[] =>
  [...a].sort((x, y) => y.issueDate.getTime() - x.issueDate.getTime() || (x.id < y.id ? -1 : 1));

beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Nachbar-Gross GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin" } });
  orgId = org.id;
  const other = await dbInternal.organization.create({ data: { legalName: "Fremde Nachbar GmbH", addressLine1: "X", postalCode: "1", city: "X" } });
  otherOrgId = other.id;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde Nachbar", addressLine1: "X 1", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  tagId = (await dbInternal.tag.create({ data: { orgId, name: "Nachbar", color: "#112233" } })).id;

  invoices = Array.from({ length: N_INV }, (_, i) => ({ id: `c17t6-inv-${String(i).padStart(4, "0")}`, issueDate: new Date(START + (i % 120) * DAY), grossTotalCents: 1_000 + ((i * 53) % 700) }));
  quotes = Array.from({ length: N_DOC }, (_, i) => ({ id: `c17t6-q-${String(i).padStart(4, "0")}`, issueDate: new Date(START + (i % 90) * DAY) }));
  notes = Array.from({ length: N_DOC }, (_, i) => ({ id: `c17t6-dn-${String(i).padStart(4, "0")}`, issueDate: new Date(START + (i % 90) * DAY) }));
  await dbInternal.invoice.createMany({ data: invoices.map((r) => ({ ...r, orgId, customerId, status: "DRAFT" })) });
  await dbInternal.quote.createMany({ data: quotes.map((r) => ({ ...r, orgId, customerId, status: "SENT", grossTotalCents: 1_000 })) });
  await dbInternal.deliveryNote.createMany({ data: notes.map((r) => ({ ...r, orgId, customerId, status: "DRAFT" })) });
  // 100 Angebote voll abgerechnet (Rohzeilen), davon 40 getaggt.
  const billed = quotes.slice(0, 100);
  await dbInternal.invoice.createMany({ data: billed.map((q) => ({ id: `${q.id}-inv`, orgId, customerId, status: "FINALIZED", grossTotalCents: 1_000 })) });
  await dbInternal.documentRelation.createMany({
    data: billed.map((q) => ({ orgId, fromType: "QUOTE", toType: "INVOICE", relationType: "CONVERTED_TO", fromId: q.id, toId: `${q.id}-inv` })),
  });
  await dbInternal.documentTag.createMany({
    data: [
      ...billed.slice(0, 40).map((q) => ({ orgId, tagId, docType: "QUOTE", docId: q.id })),
      ...invoices.slice(0, 40).map((r) => ({ orgId, tagId, docType: "INVOICE", docId: r.id })),
    ],
  });
});

describe("Nachbarn jenseits der 200er-Grenze", () => {
  it("Rechnung an Position 250: Vorgaenger 249, Nachfolger 251; Sortierung der Id-Abfrage", async () => {
    const ref = byDateDesc(invoices);
    const n = await loadNeighbors("INVOICE", orgId, ref[250].id, "status=all");
    expect(n).toMatchObject({ prevId: ref[249].id, nextId: ref[251].id });

    const gross = [...invoices].sort((a, b) => b.grossTotalCents - a.grossTotalCents || (a.id < b.id ? -1 : 1));
    // Die Listenseiten haengen kein `sort` an `liste` (nicht in ALLOWED_KEYS) — die Sortierung
    // der Id-Abfrage selbst wird daher direkt geprueft.
    const ids = await listInvoiceIds(orgId, { sort: "gross_desc", status: "draft" }, { limit: 5_000 });
    expect(ids).toEqual(gross.map((r) => r.id));
  });

  it("Angebot und Lieferschein an Position 220", async () => {
    const q = byDateDesc(quotes);
    expect(await loadNeighbors("QUOTE", orgId, q[220].id, "status=all")).toMatchObject({ prevId: q[219].id, nextId: q[221].id });
    const d = byDateDesc(notes);
    expect(await loadNeighbors("DELIVERY_NOTE", orgId, d[220].id, "status=all")).toMatchObject({ prevId: d[219].id, nextId: d[221].id });
  });

  it("keine Zusatzabfragen: kein count, kein emailLog, findMany nur mit schlankem select", async () => {
    const spies = {
      invCount: vi.spyOn(prisma.invoice, "count"),
      qCount: vi.spyOn(prisma.quote, "count"),
      dCount: vi.spyOn(prisma.deliveryNote, "count"),
      log: vi.spyOn(prisma.emailLog, "findMany"),
      inv: vi.spyOn(prisma.invoice, "findMany"),
      q: vi.spyOn(prisma.quote, "findMany"),
      d: vi.spyOn(prisma.deliveryNote, "findMany"),
    };
    await loadNeighbors("INVOICE", orgId, invoices[10].id, "status=all");
    await loadNeighbors("QUOTE", orgId, quotes[10].id, "status=all");
    await loadNeighbors("DELIVERY_NOTE", orgId, notes[10].id, "status=all");
    expect(spies.invCount).not.toHaveBeenCalled();
    expect(spies.qCount).not.toHaveBeenCalled();
    expect(spies.dCount).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
    for (const s of [spies.inv, spies.q, spies.d]) {
      expect(s).toHaveBeenCalled();
      for (const [arg] of s.mock.calls) {
        const select = (arg as { select: Record<string, unknown> }).select;
        expect(Object.keys(select).sort()).toEqual(expect.arrayContaining(["id", "issueDate"]));
        expect(select.customer).toBeUndefined();
        expect(select.lines).toBeUndefined();
      }
    }
    Object.values(spies).forEach((s) => s.mockRestore());
  });

  it("status=billed / partially-billed: Nachbarn innerhalb der abgerechneten Angebote", async () => {
    const billed = byDateDesc(quotes.slice(0, 100));
    expect(await loadNeighbors("QUOTE", orgId, billed[50].id, "status=billed")).toMatchObject({ prevId: billed[49].id, nextId: billed[51].id });
    expect(await loadNeighbors("QUOTE", orgId, billed[50].id, "status=partially-billed")).toMatchObject({ prevId: null, nextId: null });
  });

  it("Tag-Filter wirkt; fremde Org liefert keine Nachbarn", async () => {
    const tagged = byDateDesc(invoices.slice(0, 40));
    expect(await loadNeighbors("INVOICE", orgId, tagged[20].id, `tag=${tagId}`)).toMatchObject({ prevId: tagged[19].id, nextId: tagged[21].id });
    const taggedQuotes = byDateDesc(quotes.slice(0, 40));
    expect(await loadNeighbors("QUOTE", orgId, taggedQuotes[5].id, `tag=${tagId}`)).toMatchObject({ prevId: taggedQuotes[4].id, nextId: taggedQuotes[6].id });
    expect(await loadNeighbors("INVOICE", otherOrgId, invoices[0].id, "status=all")).toMatchObject({ prevId: null, nextId: null });
  });
});
