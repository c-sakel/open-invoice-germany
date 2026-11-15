/** Aufloesung des Zahlungsanbieters (rein) und Schemas der Online-Zahlung. */
import { describe, expect, it } from "vitest";
import { resolveOnlineProvider, type ResolveInput } from "@/domain/online-payment/resolve";
import {
  onlinePaymentSettingsInputSchema,
  payLinkTokenSchema,
  providerApiKeySchema,
  providerOptionsInputSchema,
} from "@/schemas/online-payment";

const ON = new Map([["MOLLIE" as const, { enabled: true, hasKey: true, currencies: ["EUR"] }]]);

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    invoiceType: "INVOICE",
    payableCents: 11900,
    currency: "EUR",
    paymentMethodCode: "TRANSFER",
    hasDirectDebitMandate: false,
    methodChoice: null,
    customerChoice: null,
    orgDefault: "MOLLIE",
    accounts: ON,
    ...over,
  };
}

describe("resolveOnlineProvider", () => {
  it("Organisationsvorgabe greift ohne weitere Angaben", () => {
    expect(resolveOnlineProvider(input())).toEqual({ provider: "MOLLIE" });
  });

  it("Vorrang: Zahlungsart > Kunde > Organisation", () => {
    expect(resolveOnlineProvider(input({ orgDefault: "NONE", customerChoice: "MOLLIE" }))).toEqual({ provider: "MOLLIE" });
    expect(resolveOnlineProvider(input({ orgDefault: "NONE", customerChoice: "NONE", methodChoice: "MOLLIE" }))).toEqual({ provider: "MOLLIE" });
    expect(resolveOnlineProvider(input({ customerChoice: "NONE" }))).toEqual({ provider: null, reason: "NONE" });
    expect(resolveOnlineProvider(input({ methodChoice: "NONE", customerChoice: "MOLLIE" }))).toEqual({ provider: null, reason: "NONE" });
  });

  it("NONE in der Organisation beendet die Kette", () => {
    expect(resolveOnlineProvider(input({ orgDefault: "NONE" }))).toEqual({ provider: null, reason: "NONE" });
  });

  it("Gutschrift und Zahlbetrag <= 0 sind nicht zahlbar", () => {
    expect(resolveOnlineProvider(input({ invoiceType: "CREDIT_NOTE" }))).toEqual({ provider: null, reason: "NOT_PAYABLE" });
    expect(resolveOnlineProvider(input({ payableCents: 0 }))).toEqual({ provider: null, reason: "NOT_PAYABLE" });
  });

  it("Lastschrift mit Mandat und Bereits-bezahlt erhalten keinen Link, auch bei Zahlungsart-Vorgabe", () => {
    expect(resolveOnlineProvider(input({ hasDirectDebitMandate: true, methodChoice: "MOLLIE" }))).toEqual({ provider: null, reason: "DIRECT_DEBIT" });
    expect(resolveOnlineProvider(input({ paymentMethodCode: "PREPAID", methodChoice: "MOLLIE" }))).toEqual({ provider: null, reason: "PREPAID" });
  });

  it("Konto aus, ohne Schluessel oder ohne Konto -> ACCOUNT_OFF", () => {
    const off = new Map([["MOLLIE" as const, { enabled: false, hasKey: true, currencies: ["EUR"] }]]);
    const noKey = new Map([["MOLLIE" as const, { enabled: true, hasKey: false, currencies: ["EUR"] }]]);
    expect(resolveOnlineProvider(input({ accounts: off }))).toEqual({ provider: null, reason: "ACCOUNT_OFF" });
    expect(resolveOnlineProvider(input({ accounts: noKey }))).toEqual({ provider: null, reason: "ACCOUNT_OFF" });
    expect(resolveOnlineProvider(input({ accounts: new Map() }))).toEqual({ provider: null, reason: "ACCOUNT_OFF" });
  });

  it("Waehrung ohne Freigabe -> CURRENCY", () => {
    expect(resolveOnlineProvider(input({ currency: "USD" }))).toEqual({ provider: null, reason: "CURRENCY" });
  });
});

describe("Schemas der Online-Zahlung", () => {
  it("Schluessel: Praefix, Laenge und Zeichensatz", () => {
    expect(providerApiKeySchema.safeParse("test_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaa").success).toBe(true);
    expect(providerApiKeySchema.safeParse("FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").success).toBe(false);
    expect(providerApiKeySchema.safeParse("test_kurz").success).toBe(false);
    expect(providerApiKeySchema.safeParse("test_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaa a").success).toBe(false);
  });

  it("Optionen: unbekannte Methoden-Id, Waehrung ausserhalb der Zwei-Dezimal-Liste, fremde Felder", () => {
    expect(providerOptionsInputSchema.safeParse({ allowedMethods: ["creditcard", "ideal"], currencies: ["EUR", "CHF"] }).success).toBe(true);
    expect(providerOptionsInputSchema.safeParse({ allowedMethods: ["Credit Card!"] }).success).toBe(false);
    expect(providerOptionsInputSchema.safeParse({ currencies: ["JPY"] }).success).toBe(false);
    expect(providerOptionsInputSchema.safeParse({ currencies: [] }).success).toBe(false);
    expect(providerOptionsInputSchema.safeParse({ apiKey: "x" }).success).toBe(false);
  });

  it("Einstellungen sind strikt, Teil-Update erlaubt", () => {
    expect(onlinePaymentSettingsInputSchema.safeParse({ showOnPdf: false }).success).toBe(true);
    expect(onlinePaymentSettingsInputSchema.safeParse({ defaultProvider: "PAYPAL" }).success).toBe(false);
    expect(onlinePaymentSettingsInputSchema.safeParse({ enabled: true }).success).toBe(false);
  });

  it("Token-Format", () => {
    expect(payLinkTokenSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(payLinkTokenSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(payLinkTokenSchema.safeParse("A".repeat(42) + "!").success).toBe(false);
  });
});
