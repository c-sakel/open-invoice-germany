import { describe, it, expect } from "vitest";
import { invoiceListBand } from "@/components/list/list-band";

const h = { grossCents: 30000, openCents: 20000, overdueCents: 5000, currency: "EUR", mixedCurrency: false };

describe("invoiceListBand", () => {
  it("teilt in bezahlt, offen, ueberfaellig", () => {
    const seg = invoiceListBand(h);
    expect(seg.map((s) => s.value)).toEqual([10000, 15000, 5000]);
    expect(seg.map((s) => s.key)).toEqual(["paid", "open", "overdue"]);
  });

  it("ueberfaellig groesser als offen: offen 0", () => {
    const seg = invoiceListBand({ ...h, overdueCents: 25000 });
    expect(seg[1].value).toBe(0);
  });

  it("negative Werte werden zu 0", () => {
    const seg = invoiceListBand({ ...h, grossCents: 1000, openCents: 5000, overdueCents: -1 });
    expect(seg.every((s) => s.value >= 0)).toBe(true);
    expect(seg[0].value).toBe(0);
  });

  it("gemischte Waehrungen: kein Band", () => {
    expect(invoiceListBand({ ...h, mixedCurrency: true })).toEqual([]);
  });
});
