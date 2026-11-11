import { describe, it, expect } from "vitest";
import { deriveStatusAfterReversal } from "@/domain/invoice/payment-reversal-status";

describe("deriveStatusAfterReversal", () => {
  it("CANCELLED bleibt bei jedem Betrag", () => {
    for (const paidCents of [0, 5000, 11900]) {
      expect(deriveStatusAfterReversal({ status: "CANCELLED", paidCents, baseCents: 11900, hasOutput: true })).toBe("CANCELLED");
    }
  });
  it("paid >= base -> PAID", () => {
    expect(deriveStatusAfterReversal({ status: "PAID", paidCents: 11900, baseCents: 11900, hasOutput: false })).toBe("PAID");
  });
  it("0 < paid < base -> PARTIALLY_PAID", () => {
    expect(deriveStatusAfterReversal({ status: "PAID", paidCents: 1, baseCents: 11900, hasOutput: true })).toBe("PARTIALLY_PAID");
  });
  it("paid 0 mit Ausgabe -> SENT", () => {
    expect(deriveStatusAfterReversal({ status: "PAID", paidCents: 0, baseCents: 11900, hasOutput: true })).toBe("SENT");
  });
  it("paid 0 ohne Ausgabe -> FINALIZED", () => {
    expect(deriveStatusAfterReversal({ status: "PARTIALLY_PAID", paidCents: 0, baseCents: 11900, hasOutput: false })).toBe("FINALIZED");
  });
});
