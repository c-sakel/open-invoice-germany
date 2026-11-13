import { describe, it, expect } from "vitest";
import { cumulativeDiscountShare } from "@/domain/invoice/partial";

describe("cumulativeDiscountShare", () => {
  it("3 x 1/3 summiert exakt auf den Quellrabatt (krummer Betrag)", () => {
    const total = 1000; // 10,00 EUR
    const qty = 3000;
    let billed = 0;
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      sum += cumulativeDiscountShare(total, qty, billed, 1000);
      billed += 1000;
    }
    expect(sum).toBe(total);
  });

  it("zeigt den Drift der Einzelrundung als Gegenprobe", () => {
    const naive = 3 * Math.round((1001 * 1000) / 3000);
    expect(naive).not.toBe(1001);
    let billed = 0;
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      sum += cumulativeDiscountShare(1001, 3000, billed, 1000);
      billed += 1000;
    }
    expect(sum).toBe(1001);
  });

  it("ungleiche Teile und Null-Rabatt", () => {
    const a = cumulativeDiscountShare(777, 7000, 0, 2500);
    const b = cumulativeDiscountShare(777, 7000, 2500, 4500);
    const c = cumulativeDiscountShare(777, 7000, 7000 - 0, 0);
    expect(a + b + c).toBe(Math.round((777 * 7000) / 7000));
    expect(cumulativeDiscountShare(0, 7000, 0, 1000)).toBe(0);
  });
});
