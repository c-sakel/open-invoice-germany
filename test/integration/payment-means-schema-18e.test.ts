/**
 * Phase 18e, Task 1 — Schema Zahlungsmittel (Glaeubiger-ID, Lastschriftmandat,
 * Kartenfelder, Lastschrift-Snapshot). Testjahr 2180.
 */
import { afterAll, describe, expect, it } from "vitest";
import { dbInternal, prisma, GobdImmutabilityError } from "@/lib/db";

afterAll(async () => {
  await dbInternal.$disconnect();
});

async function makeBase() {
  const org = await dbInternal.organization.create({
    data: { legalName: "Zahlungsmittel Test GmbH", addressLine1: "Weg 1", postalCode: "99918", city: "Testort" },
    select: { id: true, sepaCreditorId: true },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Mandat Kunde", addressLine1: "Weg 2", postalCode: "99918", city: "Testort" },
    select: {
      id: true,
      sepaMandateReference: true,
      sepaMandateSignedAt: true,
      sepaDebitIban: true,
      sepaDebitAccountName: true,
    },
  });
  return { org, customer };
}

const invoiceSelect = {
  id: true,
  cardPanTruncated: true,
  cardHolderName: true,
  cardNetwork: true,
  directDebitSnapshotJson: true,
} as const;

describe("Phase 18e Schema Zahlungsmittel", () => {
  it("Altfelder-Anlage: alle neuen Felder sind null", async () => {
    const { org, customer } = await makeBase();
    const inv = await dbInternal.invoice.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        type: "INVOICE",
        status: "DRAFT",
        taxScheme: "REGULAR",
        currency: "EUR",
      },
      select: invoiceSelect,
    });
    expect(org.sepaCreditorId).toBeNull();
    expect(customer).toMatchObject({
      sepaMandateReference: null,
      sepaMandateSignedAt: null,
      sepaDebitIban: null,
      sepaDebitAccountName: null,
    });
    expect(inv).toMatchObject({
      cardPanTruncated: null,
      cardHolderName: null,
      cardNetwork: null,
      directDebitSnapshotJson: null,
    });
  });

  it("Werte sind speicher- und lesbar", async () => {
    const { org, customer } = await makeBase();
    const signed = new Date("2180-01-15T00:00:00.000Z");
    await dbInternal.organization.update({ where: { id: org.id }, data: { sepaCreditorId: "DE98ZZZ09999999999" } });
    await dbInternal.customer.update({
      where: { id: customer.id },
      data: {
        sepaMandateReference: "MANDAT-2180-001",
        sepaMandateSignedAt: signed,
        sepaDebitIban: "DE02120300000000202051",
        sepaDebitAccountName: "Mandat Kunde",
      },
    });
    const inv = await dbInternal.invoice.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        type: "INVOICE",
        status: "DRAFT",
        taxScheme: "REGULAR",
        currency: "EUR",
        cardPanTruncated: "1234",
        cardHolderName: "Erika Muster",
        cardNetwork: "VISA",
        directDebitSnapshotJson: "{}",
      },
      select: invoiceSelect,
    });
    const o = await dbInternal.organization.findUniqueOrThrow({ where: { id: org.id }, select: { sepaCreditorId: true } });
    const c = await dbInternal.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { sepaMandateReference: true, sepaMandateSignedAt: true, sepaDebitIban: true, sepaDebitAccountName: true },
    });
    expect(o.sepaCreditorId).toBe("DE98ZZZ09999999999");
    expect(c.sepaMandateSignedAt).toBeInstanceOf(Date);
    expect(c.sepaMandateSignedAt?.toISOString()).toBe(signed.toISOString());
    expect(c.sepaMandateReference).toBe("MANDAT-2180-001");
    expect(c.sepaDebitIban).toBe("DE02120300000000202051");
    expect(inv).toMatchObject({ cardPanTruncated: "1234", cardNetwork: "VISA", directDebitSnapshotJson: "{}" });
  });

  it("festgeschriebene Rechnung: Update der Kartenfelder wirft GobdImmutabilityError", async () => {
    const { org, customer } = await makeBase();
    const inv = await dbInternal.invoice.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        type: "INVOICE",
        status: "FINALIZED",
        number: "RE-2180-0001",
        taxScheme: "REGULAR",
        currency: "EUR",
      },
      select: { id: true },
    });
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { cardNetwork: "X" } })).rejects.toBeInstanceOf(
      GobdImmutabilityError,
    );
  });
});
