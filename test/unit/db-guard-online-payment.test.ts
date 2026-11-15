/** Guard Online-Zahlung: Ereignisse append-only, Bezahlvorgaenge/-links nie loeschbar, Zuordnung unveraenderlich. */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, InvoicePayLinkImmutableError, PaymentProviderAttemptImmutableError, PaymentProviderEventImmutableError, prisma } from "@/lib/db";

let orgId = "";
let payLinkId = "";
let attemptId = "";
let eventId = "";

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Online-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  const customerId = (await dbInternal.customer.create({ data: { orgId, name: "Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  const invoiceId = (await dbInternal.invoice.create({ data: { orgId, customerId }, select: { id: true } })).id;
  payLinkId = (await dbInternal.invoicePayLink.create({ data: { orgId, invoiceId, provider: "MOLLIE", tokenHash: "hash-guard-1", tokenEnc: "enc", createdBy: "test" }, select: { id: true } })).id;
  attemptId = (await dbInternal.paymentProviderAttempt.create({ data: { orgId, payLinkId, provider: "MOLLIE", amountCents: 500, currency: "EUR" }, select: { id: true } })).id;
  eventId = (await dbInternal.paymentProviderEvent.create({ data: { orgId, provider: "MOLLIE", eventId: "tr_TestG:paid", type: "payment", objectId: "tr_TestG", result: "APPLIED" }, select: { id: true } })).id;
});

describe("PaymentProviderEvent", () => {
  it("nur create erlaubt", async () => {
    const e = PaymentProviderEventImmutableError;
    await expect(prisma.paymentProviderEvent.update({ where: { id: eventId }, data: { detail: "x" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderEvent.updateMany({ data: { detail: "x" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderEvent.upsert({ where: { id: eventId }, create: { orgId, provider: "MOLLIE", eventId: "x", type: "p", objectId: "o", result: "IGNORED" }, update: {} })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderEvent.delete({ where: { id: eventId } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderEvent.deleteMany({})).rejects.toBeInstanceOf(e);
    const created = await prisma.paymentProviderEvent.create({ data: { orgId, provider: "MOLLIE", eventId: "tr_TestG:open", type: "payment", objectId: "tr_TestG", result: "IGNORED" }, select: { id: true } });
    expect(created.id).toBeTruthy();
  });
});

describe("PaymentProviderAttempt", () => {
  it("Loeschen und Aenderung der Zuordnung gesperrt", async () => {
    const e = PaymentProviderAttemptImmutableError;
    await expect(prisma.paymentProviderAttempt.delete({ where: { id: attemptId } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderAttempt.deleteMany({})).rejects.toBeInstanceOf(e);
    for (const data of [{ amountCents: 1 }, { currency: "USD" }, { provider: "OTHER" }, { orgId: "x" }, { payLinkId: "x" }]) {
      await expect(prisma.paymentProviderAttempt.update({ where: { id: attemptId }, data })).rejects.toBeInstanceOf(e);
      await expect(prisma.paymentProviderAttempt.updateMany({ where: { id: attemptId }, data })).rejects.toBeInstanceOf(e);
      await expect(prisma.paymentProviderAttempt.updateManyAndReturn({ where: { id: attemptId }, data })).rejects.toBeInstanceOf(e);
    }
    await expect(prisma.paymentProviderAttempt.update({ where: { id: attemptId }, data: { payLink: { connect: { id: payLinkId } } } })).rejects.toBeInstanceOf(e);
    await expect(
      prisma.paymentProviderAttempt.upsert({ where: { id: attemptId }, create: { orgId, payLinkId, provider: "MOLLIE", amountCents: 1, currency: "EUR" }, update: { amountCents: 9 } }),
    ).rejects.toBeInstanceOf(e);
  });

  it("Status- und Zeitfelder fortschreibbar", async () => {
    await prisma.paymentProviderAttempt.update({ where: { id: attemptId }, data: { status: "OPEN", lastCheckedAt: new Date(), error: null } });
    const n = await prisma.paymentProviderAttempt.updateMany({ where: { id: attemptId, providerObjectId: null }, data: { providerObjectId: "tr_TestGuard", checkoutUrl: "https://pay.example.org/x" } });
    expect(n.count).toBe(1);
    const row = await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: attemptId }, select: { status: true, providerObjectId: true } });
    expect(row).toEqual({ status: "OPEN", providerObjectId: "tr_TestGuard" });
  });
});

describe("InvoicePayLink", () => {
  it("Loeschen und Aenderung von Rechnung/Token gesperrt", async () => {
    const e = InvoicePayLinkImmutableError;
    await expect(prisma.invoicePayLink.delete({ where: { id: payLinkId } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.deleteMany({})).rejects.toBeInstanceOf(e);
    for (const data of [{ invoiceId: "x" }, { provider: "X" }, { tokenHash: "x" }, { tokenEnc: "x" }, { onDocument: true }, { orgId: "x" }]) {
      await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data })).rejects.toBeInstanceOf(e);
      await expect(prisma.invoicePayLink.updateMany({ where: { id: payLinkId }, data })).rejects.toBeInstanceOf(e);
    }
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { invoice: { connect: { id: "x" } } } })).rejects.toBeInstanceOf(e);
  });

  it("Status, Deaktivierungszeit und -grund aenderbar", async () => {
    const at = new Date();
    await prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "DISABLED", disabledAt: at, disabledReason: "MANUAL" } });
    const row = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: payLinkId }, select: { status: true, disabledReason: true } });
    expect(row).toEqual({ status: "DISABLED", disabledReason: "MANUAL" });
  });
});
