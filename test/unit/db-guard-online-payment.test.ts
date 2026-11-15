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
    await expect(prisma.paymentProviderEvent.updateManyAndReturn({ data: { detail: { set: "x" } } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderEvent.update({ where: { id: eventId }, data: { org: { connect: { id: orgId } } } })).rejects.toBeInstanceOf(e);
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

describe("PaymentProviderAttempt Schluesselfelder und Status", () => {
  it("providerObjectId und checkoutUrl nur von NULL auf einen Wert", async () => {
    const e = PaymentProviderAttemptImmutableError;
    const fresh = (await dbInternal.paymentProviderAttempt.create({ data: { orgId, payLinkId, provider: "MOLLIE", amountCents: 700, currency: "EUR" }, select: { id: true } })).id;
    for (const data of [{ providerObjectId: null }, { providerObjectId: { set: null } }, { checkoutUrl: null }, { providerObjectId: "" }]) {
      await expect(prisma.paymentProviderAttempt.update({ where: { id: fresh }, data })).rejects.toBeInstanceOf(e);
    }
    await prisma.paymentProviderAttempt.update({ where: { id: fresh }, data: { providerObjectId: "tr_TestGuardNull", checkoutUrl: "https://pay.example.org/n" } });
    // bereits gesetzt: jede weitere Aenderung abgelehnt, auch per Mehrfach- und Upsert-Pfad
    await expect(prisma.paymentProviderAttempt.update({ where: { id: fresh }, data: { providerObjectId: "tr_Anderes" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderAttempt.update({ where: { id: fresh }, data: { checkoutUrl: "https://evil.example.org/" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderAttempt.updateMany({ where: { id: fresh }, data: { checkoutUrl: "https://evil.example.org/" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderAttempt.updateManyAndReturn({ where: { id: fresh }, data: { providerObjectId: { set: "tr_X" } } })).rejects.toBeInstanceOf(e);
    await expect(
      prisma.paymentProviderAttempt.upsert({ where: { id: fresh }, create: { orgId, payLinkId, provider: "MOLLIE", amountCents: 1, currency: "EUR" }, update: { providerObjectId: "tr_Y" } }),
    ).rejects.toBeInstanceOf(e);
    const row = await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: fresh }, select: { providerObjectId: true, checkoutUrl: true } });
    expect(row).toEqual({ providerObjectId: "tr_TestGuardNull", checkoutUrl: "https://pay.example.org/n" });
  });

  it("Status nur vorwaerts, Endzustaende bleiben", async () => {
    const e = PaymentProviderAttemptImmutableError;
    const id = (await dbInternal.paymentProviderAttempt.create({ data: { orgId, payLinkId, provider: "MOLLIE", amountCents: 800, currency: "EUR" }, select: { id: true } })).id;
    await prisma.paymentProviderAttempt.update({ where: { id }, data: { status: "OPEN" } });
    await expect(prisma.paymentProviderAttempt.update({ where: { id }, data: { status: "CREATING" } })).rejects.toBeInstanceOf(e);
    await prisma.paymentProviderAttempt.updateMany({ where: { id }, data: { status: { set: "PAID" } } });
    for (const status of ["OPEN", "CREATING", "FAILED", "EXPIRED", "CANCELED"]) {
      await expect(prisma.paymentProviderAttempt.update({ where: { id }, data: { status } })).rejects.toBeInstanceOf(e);
      await expect(prisma.paymentProviderAttempt.updateMany({ where: { id }, data: { status } })).rejects.toBeInstanceOf(e);
      await expect(prisma.paymentProviderAttempt.updateManyAndReturn({ where: { id }, data: { status } })).rejects.toBeInstanceOf(e);
      await expect(
        prisma.paymentProviderAttempt.upsert({ where: { id }, create: { orgId, payLinkId, provider: "MOLLIE", amountCents: 1, currency: "EUR" }, update: { status } }),
      ).rejects.toBeInstanceOf(e);
    }
    // Zeitfelder bleiben auch im Endzustand schreibbar (gleicher Status)
    await prisma.paymentProviderAttempt.update({ where: { id }, data: { status: "PAID", lastCheckedAt: new Date() } });
    const failed = (await dbInternal.paymentProviderAttempt.create({ data: { orgId, payLinkId, provider: "MOLLIE", amountCents: 900, currency: "EUR", status: "FAILED" }, select: { id: true } })).id;
    await expect(prisma.paymentProviderAttempt.update({ where: { id: failed }, data: { status: "OPEN" } })).rejects.toBeInstanceOf(e);
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

  it("Reaktivierung nur nach manueller Deaktivierung, Storno-Sperre endgueltig, Konsistenz von Zeit und Grund", async () => {
    const e = InvoicePayLinkImmutableError;
    // payLinkId steht nach dem Test davor auf DISABLED/MANUAL
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "ACTIVE" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "ACTIVE", disabledAt: new Date(), disabledReason: null } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "DISABLED", disabledAt: new Date(), disabledReason: "MANUAL" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { disabledReason: "INVOICE_CANCELLED" } })).rejects.toBeInstanceOf(e);
    await prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "ACTIVE", disabledAt: null, disabledReason: null } });
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "DISABLED" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "DISABLED", disabledAt: new Date(), disabledReason: "WEIL" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data: { status: "GELB" } })).rejects.toBeInstanceOf(e);
    await prisma.invoicePayLink.updateManyAndReturn({ where: { id: payLinkId }, data: { status: { set: "DISABLED" }, disabledAt: new Date(), disabledReason: "INVOICE_CANCELLED" } });
    for (const data of [{ status: "ACTIVE", disabledAt: null, disabledReason: null }, { status: "DISABLED", disabledAt: new Date(), disabledReason: "MANUAL" }]) {
      await expect(prisma.invoicePayLink.update({ where: { id: payLinkId }, data })).rejects.toBeInstanceOf(e);
      await expect(prisma.invoicePayLink.updateMany({ where: { id: payLinkId }, data })).rejects.toBeInstanceOf(e);
      await expect(prisma.invoicePayLink.updateManyAndReturn({ where: { id: payLinkId }, data })).rejects.toBeInstanceOf(e);
    }
  });

  it("upsert prueft den Update-Zweig", async () => {
    const e = InvoicePayLinkImmutableError;
    const create = { orgId, invoiceId: "x", provider: "MOLLIE", tokenHash: "hash-guard-up", tokenEnc: "enc", createdBy: "test" };
    await expect(prisma.invoicePayLink.upsert({ where: { id: payLinkId }, create, update: { tokenHash: "neu" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.upsert({ where: { id: payLinkId }, create, update: { status: "ACTIVE", disabledAt: null, disabledReason: null } })).rejects.toBeInstanceOf(e);
  });

  it("Vollzahlung: DISABLED mit INVOICE_PAID erlaubt, Reaktivierung nur bei wieder offener Rechnung", async () => {
    const e = InvoicePayLinkImmutableError;
    const customerId = (await dbInternal.customer.create({ data: { orgId, name: "Guard-Kunde 2", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
    const invoice = await dbInternal.invoice.create({
      data: { orgId, customerId, status: "PAID", grossTotalCents: 1000, paidAmountCents: 1000 },
      select: { id: true },
    });
    const link = await dbInternal.invoicePayLink.create({ data: { orgId, invoiceId: invoice.id, provider: "MOLLIE", tokenHash: "hash-guard-paid", tokenEnc: "enc", createdBy: "test" }, select: { id: true } });
    await prisma.invoicePayLink.update({ where: { id: link.id }, data: { status: "DISABLED", disabledAt: new Date(), disabledReason: "INVOICE_PAID" } });
    const reactivate = { status: "ACTIVE", disabledAt: null, disabledReason: null };
    await expect(prisma.invoicePayLink.update({ where: { id: link.id }, data: reactivate })).rejects.toBeInstanceOf(e);
    await dbInternal.invoice.update({ where: { id: invoice.id }, data: { status: "FINALIZED", paidAmountCents: 0 } });
    await prisma.invoicePayLink.update({ where: { id: link.id }, data: reactivate });
    const row = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: link.id }, select: { status: true } });
    expect(row.status).toBe("ACTIVE");
  });
});

describe("Zahlungsreferenz und Live-Kennzeichen", () => {
  it("providerPaymentRef nur von NULL auf einen Wert", async () => {
    const e = PaymentProviderAttemptImmutableError;
    const id = (await dbInternal.paymentProviderAttempt.create({ data: { orgId, payLinkId, provider: "STRIPE", amountCents: 600, currency: "EUR" }, select: { id: true } })).id;
    for (const data of [{ providerPaymentRef: "" }, { providerPaymentRef: null }, { providerPaymentRef: { set: "" } }]) {
      await expect(prisma.paymentProviderAttempt.update({ where: { id }, data })).rejects.toBeInstanceOf(e);
    }
    await prisma.paymentProviderAttempt.update({ where: { id }, data: { providerPaymentRef: "pi_FAKEguard1" } });
    await expect(prisma.paymentProviderAttempt.update({ where: { id }, data: { providerPaymentRef: "pi_FAKEandere" } })).rejects.toBeInstanceOf(e);
    await expect(prisma.paymentProviderAttempt.updateMany({ where: { id }, data: { providerPaymentRef: "pi_FAKEandere" } })).rejects.toBeInstanceOf(e);
    const row = await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id }, select: { providerPaymentRef: true } });
    expect(row.providerPaymentRef).toBe("pi_FAKEguard1");
  });

  it("liveIssued nur auf true, nie zurueck", async () => {
    const e = InvoicePayLinkImmutableError;
    const customerId = (await dbInternal.customer.create({ data: { orgId, name: "Live-Kunde", addressLine1: "Weg 3", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
    const invoiceId = (await dbInternal.invoice.create({ data: { orgId, customerId }, select: { id: true } })).id;
    const id = (await dbInternal.invoicePayLink.create({ data: { orgId, invoiceId, provider: "STRIPE", tokenHash: "hash-guard-live", tokenEnc: "enc", createdBy: "test", liveIssued: false }, select: { id: true } })).id;
    await expect(prisma.invoicePayLink.update({ where: { id }, data: { liveIssued: false } })).rejects.toBeInstanceOf(e);
    await expect(prisma.invoicePayLink.updateMany({ where: { id }, data: { liveIssued: { set: false } } })).rejects.toBeInstanceOf(e);
    const n = await prisma.invoicePayLink.updateMany({ where: { id, liveIssued: false }, data: { liveIssued: true } });
    expect(n.count).toBe(1);
    await expect(prisma.invoicePayLink.update({ where: { id }, data: { liveIssued: false } })).rejects.toBeInstanceOf(e);
    const row = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id }, select: { liveIssued: true } });
    expect(row.liveIssued).toBe(true);
  });
});
