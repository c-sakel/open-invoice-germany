import { describe, it, expect } from "vitest";
import { openAmountCents, payableBaseCents, reversedCentsByPayment } from "@/domain/invoice/amounts";

describe("payableBaseCents/openAmountCents (Phase 5 — Schlussrechnung-Bemessungsgrundlage)", () => {
  it("nutzt grossTotalCents, wenn payableCents NULL ist (normale Rechnung/Teil-/Abschlagsrechnung)", () => {
    const inv = { grossTotalCents: 119_000, payableCents: null, paidAmountCents: 0 };
    expect(payableBaseCents(inv)).toBe(119_000);
    expect(openAmountCents(inv)).toBe(119_000);
  });

  it("nutzt payableCents statt grossTotalCents, wenn gesetzt (Schlussrechnung)", () => {
    // Lastenheft-Beispiel: Gesamtleistung brutto 11.900, zwei Abschlaege a 3.570 -> Rest 4.760.
    const inv = { grossTotalCents: 1_190_000, payableCents: 476_000, paidAmountCents: 0 };
    expect(payableBaseCents(inv)).toBe(476_000);
    expect(openAmountCents(inv)).toBe(476_000);
  });

  it("zieht bereits erfasste Zahlungen von der Bemessungsgrundlage ab", () => {
    const inv = { grossTotalCents: 1_190_000, payableCents: 476_000, paidAmountCents: 476_000 };
    expect(openAmountCents(inv)).toBe(0);
  });
});

describe("reversedCentsByPayment (Phase 16a)", () => {
  it("summiert Teil- und Vollgegenbuchungen je Zahlung positiv", () => {
    const map = reversedCentsByPayment([
      { kind: "PAYMENT", amountCents: 10_000, reversesPaymentId: null },
      { kind: "REVERSAL", amountCents: -4_000, reversesPaymentId: "p1" },
      { kind: "REVERSAL", amountCents: -6_000, reversesPaymentId: "p1" },
      { kind: "REVERSAL", amountCents: -500, reversesPaymentId: "p2" },
    ]);
    expect(map.get("p1")).toBe(10_000);
    expect(map.get("p2")).toBe(500);
    expect(map.size).toBe(2);
  });

  it("ignoriert Zeilen anderer kinds und Gegenbuchungen ohne Verweis", () => {
    const map = reversedCentsByPayment([
      { kind: "PAYMENT", amountCents: 5_000, reversesPaymentId: "p1" },
      { kind: "REVERSAL", amountCents: -100, reversesPaymentId: null },
    ]);
    expect(map.size).toBe(0);
  });
});
