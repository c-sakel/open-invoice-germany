import { describe, it, expect } from "vitest";
import { invoiceListBand } from "@/components/list/list-band";

const h = { paidCents: 10000, notDueCents: 15000, dueCents: 2000, overdueCents: 5000, currency: "EUR", mixedCurrency: false };

describe("invoiceListBand", () => {
  it("teilt in bezahlt, offen, faellig, ueberfaellig", () => {
    const seg = invoiceListBand(h);
    expect(seg.map((s) => s.value)).toEqual([10000, 15000, 2000, 5000]);
    expect(seg.map((s) => s.key)).toEqual(["paid", "open", "due", "overdue"]);
  });

  it("nur Entwuerfe und Ueberfaellige, nichts bezahlt: Bezahlt 0", () => {
    const seg = invoiceListBand({ ...h, paidCents: 0, notDueCents: 0, dueCents: 0, overdueCents: 20000 });
    expect(seg[0].value).toBe(0);
    expect(seg[3].value).toBe(20000);
  });

  it("negative Werte werden zu 0", () => {
    const seg = invoiceListBand({ ...h, paidCents: -5, overdueCents: -1 });
    expect(seg.every((s) => s.value >= 0)).toBe(true);
  });

  it("gemischte Waehrungen: kein Band", () => {
    expect(invoiceListBand({ ...h, mixedCurrency: true })).toEqual([]);
  });
});
