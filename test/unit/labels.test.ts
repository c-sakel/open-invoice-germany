import { describe, it, expect } from "vitest";
import { paymentMethodLabel } from "@/lib/payment-method-label";
import { taxSchemeLabel } from "@/lib/tax-scheme-label";

describe("Klartext-Labels", () => {
  it("Zahlungsarten", () => {
    expect(paymentMethodLabel("TRANSFER")).toBe("Überweisung");
    expect(paymentMethodLabel("CREDIT_NOTE")).toBe("Verrechnung Gutschrift");
    expect(paymentMethodLabel("EIGENER_CODE")).toBe("EIGENER_CODE");
  });
  it("Steuerschemata", () => {
    expect(taxSchemeLabel("REGULAR")).toBe("Regelbesteuerung");
    expect(taxSchemeLabel("XYZ")).toBe("XYZ");
  });
});
