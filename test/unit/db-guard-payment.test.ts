/**
 * Phase 16a (Final-Fix) — Payment-Guard in src/lib/db.ts: Zahlungen sind append-only; jede
 * Aenderung oder Loeschung ueber den geschuetzten Client wird verweigert (Korrektur nur per
 * Gegenbuchung).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma } from "@/lib/db";

let paymentId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Payment-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Payment-Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const invoice = await dbInternal.invoice.create({ data: { orgId: org.id, customerId: customer.id }, select: { id: true } });
  const payment = await dbInternal.payment.create({ data: { invoiceId: invoice.id, amountCents: 1000 }, select: { id: true } });
  paymentId = payment.id;
});

describe("Payment-Guard (Phase 16a)", () => {
  it("verweigert update/updateMany/upsert/delete/deleteMany", async () => {
    const where = { id: paymentId };
    await expect(prisma.payment.update({ where, data: { amountCents: 1 } })).rejects.toThrow(/Gegenbuchung/);
    await expect(prisma.payment.updateMany({ where, data: { amountCents: 1 } })).rejects.toThrow(/Gegenbuchung/);
    await expect(prisma.payment.updateManyAndReturn({ where, data: { amountCents: 1 } })).rejects.toThrow(/Gegenbuchung/);
    await expect(
      prisma.payment.upsert({ where, create: { invoiceId: "x", amountCents: 1 }, update: { amountCents: 1 } }),
    ).rejects.toThrow(/Gegenbuchung/);
    await expect(prisma.payment.delete({ where })).rejects.toThrow(/Gegenbuchung/);
    await expect(prisma.payment.deleteMany({ where })).rejects.toThrow(/Gegenbuchung/);
    const row = await dbInternal.payment.findUniqueOrThrow({ where, select: { amountCents: true } });
    expect(row.amountCents).toBe(1000);
  });

  it("erlaubt Anlegen und Lesen", async () => {
    const found = await prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true } });
    expect(found?.id).toBe(paymentId);
  });
});
