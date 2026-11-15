/**
 * GoBD-Guard fuer Rechnungspositionen: create/createMany/createManyAndReturn/upsert/updateManyAndReturn
 * ueber den geschuetzten Client nur an Entwuerfe.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, GobdImmutabilityError, prisma } from "@/lib/db";

let orgId = "";
let draftId = "";
let finalId = "";
let finalLineId = "";

function line(invoiceId: string, position: number) {
  return { invoiceId, position, description: "Pos", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19, lineNetCents: 100 };
}

async function makeInvoice(status: string, number: string | null, customerId: string) {
  return dbInternal.invoice.create({
    data: { orgId, customerId, status, number, issueDate: new Date("2186-03-01T00:00:00Z") } as never,
    select: { id: true },
  });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Positions-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Positions-Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  draftId = (await makeInvoice("DRAFT", null, customer.id)).id;
  finalId = (await makeInvoice("FINALIZED", "RE-GUARD-2186-1", customer.id)).id;
  finalLineId = (await dbInternal.invoiceLine.create({ data: line(finalId, 1) as never, select: { id: true } })).id;
});

describe("InvoiceLine-Guard fuer neue Positionen", () => {
  it("create/createMany/createManyAndReturn/upsert an FINALIZED -> Fehler", async () => {
    await expect(prisma.invoiceLine.create({ data: line(finalId, 2) as never })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(prisma.invoiceLine.create({ data: { ...line(finalId, 2), invoiceId: undefined, invoice: { connect: { id: finalId } } } as never })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(prisma.invoiceLine.createMany({ data: [line(draftId, 9), line(finalId, 3)] as never })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(prisma.invoiceLine.createManyAndReturn({ data: [line(finalId, 3)] as never })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(
      prisma.invoiceLine.upsert({ where: { id: "gibt-es-nicht" }, create: line(finalId, 4) as never, update: {} }),
    ).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(
      prisma.invoiceLine.upsert({ where: { id: finalLineId }, create: line(draftId, 4) as never, update: { description: "x" } }),
    ).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(
      prisma.invoiceLine.updateManyAndReturn({ where: { invoiceId: finalId }, data: { description: "x" } }),
    ).rejects.toBeInstanceOf(GobdImmutabilityError);
    expect(await dbInternal.invoiceLine.count({ where: { invoiceId: finalId } })).toBe(1);
    expect(await dbInternal.invoiceLine.count({ where: { invoiceId: draftId } })).toBe(0);
  });

  it("an DRAFT erlaubt", async () => {
    await prisma.invoiceLine.create({ data: line(draftId, 1) as never });
    await prisma.invoiceLine.createMany({ data: [line(draftId, 2), line(draftId, 3)] as never });
    const rows = await prisma.invoiceLine.createManyAndReturn({ data: [line(draftId, 4)] as never, select: { id: true } });
    expect(rows).toHaveLength(1);
    await prisma.invoiceLine.upsert({ where: { id: "neu-nicht-da" }, create: line(draftId, 5) as never, update: {} });
    expect(await dbInternal.invoiceLine.count({ where: { invoiceId: draftId } })).toBe(5);
  });

  it("dbInternal darf weiter schreiben", async () => {
    await dbInternal.invoiceLine.create({ data: line(finalId, 7) as never });
    expect(await dbInternal.invoiceLine.count({ where: { invoiceId: finalId } })).toBe(2);
  });
});
