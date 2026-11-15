/** Schema Online-Zahlung: Standardwerte, Eindeutigkeiten, NULL-Objekt-Ids und Restrict-Fremdschluessel. */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";

let orgId = "";
let customerId = "";
let invoiceId = "";
let payLinkId = "";

const attempt = (extra: Record<string, unknown> = {}) => ({
  orgId, payLinkId, provider: "MOLLIE", amountCents: 1000, currency: "EUR", ...extra,
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Online-Schema GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Schema-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  invoiceId = (await dbInternal.invoice.create({ data: { orgId, customerId }, select: { id: true } })).id;
  payLinkId = (
    await dbInternal.invoicePayLink.create({
      data: { orgId, invoiceId, provider: "MOLLIE", tokenHash: "hash-schema-1", tokenEnc: "enc", createdBy: "test" },
      select: { id: true },
    })
  ).id;
});

describe("Online-Zahlung Schema", () => {
  it("Standardwerte", async () => {
    const s = await dbInternal.paymentProviderSettings.create({ data: { orgId }, select: { defaultProvider: true, showOnPdf: true, showInMail: true, showInPortal: true } });
    expect(s).toEqual({ defaultProvider: "NONE", showOnPdf: true, showInMail: true, showInPortal: true });
    const a = await dbInternal.paymentProviderAccount.create({ data: { orgId, provider: "MOLLIE", webhookPathId: "wh-schema-1" }, select: { enabled: true, mode: true, apiKeyEnc: true } });
    expect(a).toEqual({ enabled: false, mode: null, apiKeyEnc: null });
    const l = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: payLinkId }, select: { status: true, onDocument: true } });
    expect(l).toEqual({ status: "ACTIVE", onDocument: false });
    const t = await dbInternal.paymentProviderAttempt.create({ data: attempt(), select: { status: true, providerObjectId: true } });
    expect(t).toEqual({ status: "CREATING", providerObjectId: null });
  });

  it("Eindeutigkeiten -> P2002", async () => {
    expect(await code(dbInternal.paymentProviderSettings.create({ data: { orgId } }))).toBe("P2002");
    expect(await code(dbInternal.paymentProviderAccount.create({ data: { orgId, provider: "MOLLIE", webhookPathId: "wh-schema-2" } }))).toBe("P2002");
    const other = (await dbInternal.organization.create({ data: { legalName: "Online-Schema Zwei", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
    expect(await code(dbInternal.paymentProviderAccount.create({ data: { orgId: other, provider: "MOLLIE", webhookPathId: "wh-schema-1" } }))).toBe("P2002");
    expect(await code(dbInternal.invoicePayLink.create({ data: { orgId, invoiceId, provider: "MOLLIE", tokenHash: "hash-schema-9", tokenEnc: "e", createdBy: "t" } }))).toBe("P2002");
    const inv2 = (await dbInternal.invoice.create({ data: { orgId, customerId }, select: { id: true } })).id;
    expect(await code(dbInternal.invoicePayLink.create({ data: { orgId, invoiceId: inv2, provider: "MOLLIE", tokenHash: "hash-schema-1", tokenEnc: "e", createdBy: "t" } }))).toBe("P2002");
    const ev = { orgId, provider: "MOLLIE", eventId: "tr_TestA:paid", type: "payment", objectId: "tr_TestA", result: "APPLIED" };
    await dbInternal.paymentProviderEvent.create({ data: ev });
    expect(await code(dbInternal.paymentProviderEvent.create({ data: ev }))).toBe("P2002");
  });

  it("zwei Vorgaenge ohne Objekt-Id erlaubt, gleiche Objekt-Id nicht", async () => {
    await dbInternal.paymentProviderAttempt.create({ data: attempt() });
    expect(await dbInternal.paymentProviderAttempt.count({ where: { payLinkId, providerObjectId: null } })).toBeGreaterThanOrEqual(2);
    await dbInternal.paymentProviderAttempt.create({ data: attempt({ providerObjectId: "tr_TestDup" }) });
    expect(await code(dbInternal.paymentProviderAttempt.create({ data: attempt({ providerObjectId: "tr_TestDup" }) }))).toBe("P2002");
  });

  it("Zahlungsreferenz: mehrere NULL erlaubt, gleiche (Anbieter, Referenz) nicht", async () => {
    await dbInternal.paymentProviderAttempt.create({ data: attempt({ provider: "STRIPE" }) });
    await dbInternal.paymentProviderAttempt.create({ data: attempt({ provider: "STRIPE" }) });
    await dbInternal.paymentProviderAttempt.create({ data: attempt({ provider: "STRIPE", providerPaymentRef: "pi_FAKEdup1" }) });
    expect(await code(dbInternal.paymentProviderAttempt.create({ data: attempt({ provider: "STRIPE", providerPaymentRef: "pi_FAKEdup1" }) }))).toBe("P2002");
    await dbInternal.paymentProviderAttempt.create({ data: attempt({ provider: "MOLLIE", providerPaymentRef: "pi_FAKEdup1" }) });
  });

  it("Bezahllink: liveIssued Standard true", async () => {
    const row = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: payLinkId }, select: { liveIssued: true } });
    expect(row.liveIssued).toBe(true);
  });

  it("Rechnung mit Bezahllink nicht loeschbar (Fremdschluessel)", async () => {
    expect(await code(dbInternal.invoice.delete({ where: { id: invoiceId } }))).toBeDefined();
    expect(await dbInternal.invoice.count({ where: { id: invoiceId } })).toBe(1);
  });
});
