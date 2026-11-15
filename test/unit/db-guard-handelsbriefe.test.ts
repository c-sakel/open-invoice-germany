/**
 * GoBD-Guard fuer Angebote und Lieferscheine: nach der Ausgabe sind Positionen gesperrt und am Kopf
 * nur Status, Statuszeitpunkte, Verknuepfungen und Archivmarker aenderbar (§ 257 HGB).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, GobdImmutabilityError, HandelsbriefImmutabilityError, prisma } from "@/lib/db";

let orgId = "";
let customerId = "";
const q = { draft: "", sent: "", sentLine: "" };
const d = { draft: "", created: "", createdLine: "" };

const qLine = (quoteId: string, position: number) => ({
  quoteId, position, description: "Pos", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19, lineNetCents: 100,
});
const dLine = (deliveryNoteId: string, position: number) => ({ deliveryNoteId, position, description: "Pos", quantityMilli: 1000 });

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Handelsbrief-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Handelsbrief-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
      select: { id: true },
    })
  ).id;
  q.draft = (await dbInternal.quote.create({ data: { orgId, customerId, status: "DRAFT" }, select: { id: true } })).id;
  q.sent = (await dbInternal.quote.create({ data: { orgId, customerId, status: "SENT", number: "AN-GUARD-2230-1" }, select: { id: true } })).id;
  q.sentLine = (await dbInternal.quoteLine.create({ data: qLine(q.sent, 1), select: { id: true } })).id;
  d.draft = (await dbInternal.deliveryNote.create({ data: { orgId, customerId, status: "DRAFT" }, select: { id: true } })).id;
  d.created = (await dbInternal.deliveryNote.create({ data: { orgId, customerId, status: "CREATED", number: "LS-GUARD-2230-1" }, select: { id: true } })).id;
  d.createdLine = (await dbInternal.deliveryNoteLine.create({ data: dLine(d.created, 1), select: { id: true } })).id;
});

describe("Angebot nach Ausgabe", () => {
  it("Positionen anlegen/aendern/loeschen -> Fehler", async () => {
    const err = HandelsbriefImmutabilityError;
    await expect(prisma.quoteLine.create({ data: qLine(q.sent, 2) })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.create({ data: { ...qLine(q.sent, 2), quoteId: undefined, quote: { connect: { id: q.sent } } } as never })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.createMany({ data: [qLine(q.draft, 9), qLine(q.sent, 3)] })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.createManyAndReturn({ data: [qLine(q.sent, 3)] })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.upsert({ where: { id: "gibt-es-nicht" }, create: qLine(q.sent, 4), update: {} })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.update({ where: { id: q.sentLine }, data: { description: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.updateMany({ where: { quoteId: q.sent }, data: { description: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.updateManyAndReturn({ where: { quoteId: q.sent }, data: { description: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.delete({ where: { id: q.sentLine } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.deleteMany({ where: { quoteId: q.sent } })).rejects.toBeInstanceOf(err);
    expect(await dbInternal.quoteLine.count({ where: { quoteId: q.sent } })).toBe(1);
  });

  it("Kopf: Inhaltsfelder und Loeschen gesperrt, geschachtelte Positionen ebenso", async () => {
    const err = HandelsbriefImmutabilityError;
    await expect(prisma.quote.update({ where: { id: q.sent }, data: { subject: "neu" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.update({ where: { id: q.sent }, data: { grossTotalCents: 5 } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.update({ where: { id: q.sent }, data: { status: "ACCEPTED", notes: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.update({ where: { id: q.sent }, data: { lines: { deleteMany: {} } } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.updateMany({ where: { id: q.sent }, data: { notes: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.delete({ where: { id: q.sent } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.deleteMany({ where: { id: q.sent } })).rejects.toBeInstanceOf(err);
  });

  it("Statuswechsel, Entscheidung, Umwandlungs-Verknuepfung und Archiv erlaubt", async () => {
    const now = new Date("2230-03-01T00:00:00Z");
    await prisma.quote.update({ where: { id: q.sent }, data: { status: "ACCEPTED", decidedAt: now, decisionNote: "ok" } });
    await prisma.quote.update({ where: { id: q.sent }, data: { convertedToInvoiceId: "inv-1" } });
    await prisma.quote.update({ where: { id: q.sent }, data: { archivedAt: now } });
    expect((await dbInternal.quote.findUniqueOrThrow({ where: { id: q.sent }, select: { status: true } })).status).toBe("ACCEPTED");
  });

  it("Entwurf bleibt frei", async () => {
    await prisma.quoteLine.create({ data: qLine(q.draft, 1) });
    await prisma.quoteLine.createMany({ data: [qLine(q.draft, 2), qLine(q.draft, 3)] });
    await prisma.quoteLine.updateMany({ where: { quoteId: q.draft }, data: { description: "neu" } });
    await prisma.quoteLine.deleteMany({ where: { quoteId: q.draft } });
    expect(await dbInternal.quoteLine.count({ where: { quoteId: q.draft } })).toBe(0);
    await prisma.quote.update({ where: { id: q.draft }, data: { subject: "neu", status: "SENT", sentAt: new Date() } });
  });
});

describe("Lieferschein nach Ausgabe", () => {
  it("Positionen anlegen/aendern/loeschen -> Fehler", async () => {
    const err = HandelsbriefImmutabilityError;
    await expect(prisma.deliveryNoteLine.create({ data: dLine(d.created, 2) })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.createMany({ data: [dLine(d.draft, 9), dLine(d.created, 3)] })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.createManyAndReturn({ data: [dLine(d.created, 3)] })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.upsert({ where: { id: d.createdLine }, create: dLine(d.draft, 4), update: { description: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.update({ where: { id: d.createdLine }, data: { quantityMilli: 5 } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.updateMany({ where: { deliveryNoteId: d.created }, data: { description: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.updateManyAndReturn({ where: { deliveryNoteId: d.created }, data: { description: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.delete({ where: { id: d.createdLine } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.deleteMany({ where: { deliveryNoteId: d.created } })).rejects.toBeInstanceOf(err);
    expect(await dbInternal.deliveryNoteLine.count({ where: { deliveryNoteId: d.created } })).toBe(1);
  });

  it("Kopf: Inhaltsfeld und Loeschen gesperrt; Status/Zeitpunkte/Archiv erlaubt", async () => {
    const err = HandelsbriefImmutabilityError;
    await expect(prisma.deliveryNote.update({ where: { id: d.created }, data: { notes: "x" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNote.update({ where: { id: d.created }, data: { showPrices: true } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNote.delete({ where: { id: d.created } })).rejects.toBeInstanceOf(err);
    const now = new Date("2230-03-02T00:00:00Z");
    await prisma.deliveryNote.update({ where: { id: d.created }, data: { status: "SENT", sentAt: now } });
    await prisma.deliveryNote.update({ where: { id: d.created }, data: { status: "DELIVERED", deliveredAt: now } });
    await prisma.deliveryNote.update({ where: { id: d.created }, data: { archivedAt: now } });
  });

  it("Entwurf bleibt frei", async () => {
    await prisma.deliveryNoteLine.create({ data: dLine(d.draft, 1) });
    await prisma.deliveryNote.update({ where: { id: d.draft }, data: { notes: "neu", status: "CREATED" } });
    expect(await dbInternal.deliveryNoteLine.count({ where: { deliveryNoteId: d.draft } })).toBe(1);
  });
});

describe("Status nur vorwaerts, Umhaengen von Positionen", () => {
  const err = HandelsbriefImmutabilityError;
  let q2 = "";
  let qDraftLine = "";
  let qDraftQuote = "";
  let dDraftNote = "";
  let d2 = "";
  let dDraftLine = "";
  let d2Line = "";

  beforeAll(async () => {
    q2 = (await dbInternal.quote.create({ data: { orgId, customerId, status: "SENT", number: "AN-GUARD-2230-2" }, select: { id: true } })).id;
    const qd = (await dbInternal.quote.create({ data: { orgId, customerId, status: "DRAFT" }, select: { id: true } })).id;
    qDraftQuote = qd;
    qDraftLine = (await dbInternal.quoteLine.create({ data: qLine(qd, 20), select: { id: true } })).id;
    d2 = (await dbInternal.deliveryNote.create({ data: { orgId, customerId, status: "CREATED", number: "LS-GUARD-2230-2" }, select: { id: true } })).id;
    d2Line = (await dbInternal.deliveryNoteLine.create({ data: dLine(d2, 1), select: { id: true } })).id;
    const dd = (await dbInternal.deliveryNote.create({ data: { orgId, customerId, status: "DRAFT" }, select: { id: true } })).id;
    dDraftNote = dd;
    dDraftLine = (await dbInternal.deliveryNoteLine.create({ data: dLine(dd, 20), select: { id: true } })).id;
  });

  it("Angebot: kein Zurueck auf DRAFT, kein Rueckwaertssprung, kein unbekannter Status", async () => {
    await expect(prisma.quote.update({ where: { id: q2 }, data: { status: "DRAFT" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.update({ where: { id: q2 }, data: { status: { set: "DRAFT" } } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.updateMany({ where: { id: q2 }, data: { status: "DRAFT" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.updateManyAndReturn({ where: { id: q2 }, data: { status: "DRAFT" } })).rejects.toBeInstanceOf(err);
    await expect(
      prisma.quote.upsert({ where: { id: q2 }, update: { status: "DRAFT" }, create: { orgId, customerId } }),
    ).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.update({ where: { id: q2 }, data: { status: "quatsch" as never } })).rejects.toBeInstanceOf(err);
    await prisma.quote.update({ where: { id: q2 }, data: { status: "ACCEPTED" } });
    await expect(prisma.quote.update({ where: { id: q2 }, data: { status: "SENT" } })).rejects.toBeInstanceOf(err);
    await prisma.quote.update({ where: { id: q2 }, data: { status: "CANCELLED" } });
    await expect(prisma.quote.update({ where: { id: q2 }, data: { status: "ACCEPTED" } })).rejects.toBeInstanceOf(err);
    expect((await dbInternal.quote.findUniqueOrThrow({ where: { id: q2 }, select: { status: true } })).status).toBe("CANCELLED");
  });

  it("Lieferschein: kein Zurueck auf DRAFT oder CREATED", async () => {
    await expect(prisma.deliveryNote.update({ where: { id: d2 }, data: { status: "DRAFT" } })).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNote.updateMany({ where: { id: d2 }, data: { status: "DRAFT" } })).rejects.toBeInstanceOf(err);
    await expect(
      prisma.deliveryNote.upsert({ where: { id: d2 }, update: { status: "DRAFT" }, create: { orgId, customerId } }),
    ).rejects.toBeInstanceOf(err);
    await prisma.deliveryNote.update({ where: { id: d2 }, data: { status: "DELIVERED" } });
    await expect(prisma.deliveryNote.update({ where: { id: d2 }, data: { status: "CREATED" } })).rejects.toBeInstanceOf(err);
  });

  it("Inhaltsfeld an ausgegebenem Beleg: upsert/updateMany gesperrt", async () => {
    await expect(
      prisma.quote.upsert({ where: { id: q.sent }, update: { subject: "x" }, create: { orgId, customerId } }),
    ).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNote.updateMany({ where: { id: d.created }, data: { notes: "x" } })).rejects.toBeInstanceOf(err);
    await expect(
      prisma.deliveryNoteLine.create({ data: { position: 7, description: "P", quantityMilli: 1000, deliveryNote: { connect: { id: d.created } } } }),
    ).rejects.toBeInstanceOf(err);
  });

  it("Position in ausgegebenen Beleg umhaengen gesperrt (update/updateMany/upsert)", async () => {
    await expect(prisma.quoteLine.update({ where: { id: qDraftLine }, data: { quoteId: q.sent } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.update({ where: { id: qDraftLine }, data: { quote: { connect: { id: q.sent } } } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quoteLine.updateMany({ where: { id: qDraftLine }, data: { quoteId: q.sent } })).rejects.toBeInstanceOf(err);
    await expect(
      prisma.quoteLine.upsert({ where: { id: qDraftLine }, update: { quoteId: q.sent }, create: qLine(qDraftQuote, 21) }),
    ).rejects.toBeInstanceOf(err);
    await expect(prisma.deliveryNoteLine.update({ where: { id: dDraftLine }, data: { deliveryNoteId: d.created } })).rejects.toBeInstanceOf(err);
    await expect(
      prisma.deliveryNoteLine.updateManyAndReturn({ where: { id: dDraftLine }, data: { deliveryNoteId: d.created } }),
    ).rejects.toBeInstanceOf(err);
    expect((await dbInternal.quoteLine.findUniqueOrThrow({ where: { id: qDraftLine }, select: { quoteId: true } })).quoteId).toBe(qDraftQuote);
  });

  it("Position aus ausgegebenem Beleg per lines.connect/set am Entwurf entfernen gesperrt", async () => {
    await expect(prisma.quote.update({ where: { id: qDraftQuote }, data: { lines: { connect: { id: q.sentLine } } } })).rejects.toBeInstanceOf(err);
    await expect(prisma.quote.update({ where: { id: qDraftQuote }, data: { lines: { set: [{ id: q.sentLine }] } } })).rejects.toBeInstanceOf(err);
    await expect(
      prisma.quote.create({ data: { orgId, customerId, lines: { connect: { id: q.sentLine } } } }),
    ).rejects.toBeInstanceOf(err);
    await expect(
      prisma.deliveryNote.update({ where: { id: dDraftNote }, data: { lines: { connect: { id: d2Line } } } }),
    ).rejects.toBeInstanceOf(err);
    expect((await dbInternal.quoteLine.findUniqueOrThrow({ where: { id: q.sentLine }, select: { quoteId: true } })).quoteId).toBe(q.sent);
  });

  it("Entwurf: Position zwischen Entwuerfen umhaengen bleibt erlaubt", async () => {
    const a = (await dbInternal.quote.create({ data: { orgId, customerId, status: "DRAFT" }, select: { id: true } })).id;
    const b = (await dbInternal.quote.create({ data: { orgId, customerId, status: "DRAFT" }, select: { id: true } })).id;
    const line = (await dbInternal.quoteLine.create({ data: qLine(a, 1), select: { id: true } })).id;
    await prisma.quoteLine.update({ where: { id: line }, data: { quoteId: b } });
    await prisma.quoteLine.update({ where: { id: line }, data: { quote: { connect: { id: a } } } });
  });

  it("Rechnung: Position nicht in festgeschriebene Rechnung umhaengen", async () => {
    const inv = (n: string, status: "DRAFT" | "FINALIZED") =>
      dbInternal.invoice.create({
        data: { orgId, customerId, status, number: status === "DRAFT" ? null : n, type: "INVOICE" } as never,
        select: { id: true },
      });
    const fin = await inv("RE-GUARD-2230-1", "FINALIZED");
    const dr = await inv("", "DRAFT");
    const line = await dbInternal.invoiceLine.create({
      data: { invoiceId: dr.id, position: 1, description: "P", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19, lineNetCents: 100 } as never,
      select: { id: true },
    });
    await expect(prisma.invoiceLine.update({ where: { id: line.id }, data: { invoiceId: fin.id } })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(prisma.invoice.update({ where: { id: dr.id }, data: { lines: { connect: { id: line.id } } } }).then(() => "ok")).resolves.toBe("ok");
    const finLine = await dbInternal.invoiceLine.create({
      data: { invoiceId: fin.id, position: 1, description: "P", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19, lineNetCents: 100 } as never,
      select: { id: true },
    });
    await expect(prisma.invoice.update({ where: { id: dr.id }, data: { lines: { connect: { id: finLine.id } } } })).rejects.toBeInstanceOf(GobdImmutabilityError);
  });
});
