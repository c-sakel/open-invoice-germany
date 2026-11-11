import { describe, expect, it } from "vitest";
import {
  aggregateOssYear,
  contributionEurCents,
  isOssBuyer,
  ossLevel,
  ownEurCents,
  ossYearOf,
  type OssDoc,
} from "@/domain/reporting/oss-calc";

let seq = 0;
function doc(o: Partial<OssDoc> = {}): OssDoc {
  seq += 1;
  return {
    id: `d${seq}`,
    type: "INVOICE",
    currency: "EUR",
    issueDate: new Date("2116-03-01T00:00:00Z"),
    deliveryDate: null,
    deliveryEnd: null,
    buyer: { countryCode: "AT", vatId: null },
    netTotalCents: 10000,
    netTotalEurCents: 10000,
    fxRateMicros: null,
    documentDiscountPermille: 0,
    documentDiscountCents: 0,
    documentChargePermille: 0,
    documentChargeCents: 0,
    lines: [],
    correctsInvoiceId: null,
    deductedDownpaymentIds: [],
    ...o,
  };
}
const line = (lineNetCents: number, ossCategory: string | null, lineType = "ITEM") => ({ lineType, lineNetCents, ossCategory });
const none = new Map<string, OssDoc>();
const rel = (...ds: OssDoc[]) => new Map(ds.map((d) => [d.id, d]));

describe("isOssBuyer", () => {
  it("klassifiziert EU-B2C", () => {
    expect(isOssBuyer({ countryCode: "AT", vatId: null })).toBe(true);
    expect(isOssBuyer({ countryCode: "AT", vatId: "ATU12345678" })).toBe(false);
    expect(isOssBuyer({ countryCode: "AT", vatId: "  " })).toBe(true);
    expect(isOssBuyer({ countryCode: "DE", vatId: null })).toBe(false);
    expect(isOssBuyer({ countryCode: "CH", vatId: null })).toBe(false);
    expect(isOssBuyer({ countryCode: "GR", vatId: null })).toBe(true);
    expect(isOssBuyer(null)).toBe(false);
  });
});

describe("ossYearOf", () => {
  it("nutzt den Leistungszeitpunkt", () => {
    expect(ossYearOf(doc({ issueDate: new Date("2116-01-05T00:00:00Z"), deliveryDate: new Date("2115-12-20T00:00:00Z") }))).toBe(2115);
    expect(ossYearOf(doc({ issueDate: new Date("2116-01-05T00:00:00Z"), deliveryEnd: new Date("2115-12-31T00:00:00Z") }))).toBe(2115);
    expect(ossYearOf(doc({ issueDate: new Date("2116-01-05T00:00:00Z") }))).toBe(2116);
  });
});

describe("ownEurCents ALL_EU_B2C", () => {
  it("EUR und Fremdwaehrung", () => {
    expect(ownEurCents(doc({ netTotalEurCents: 9000 }), "ALL_EU_B2C")).toBe(9000);
    expect(ownEurCents(doc({ netTotalEurCents: null }), "ALL_EU_B2C")).toBe(10000);
    expect(ownEurCents(doc({ currency: "USD", netTotalEurCents: 8917 }), "ALL_EU_B2C")).toBe(8917);
    expect(ownEurCents(doc({ currency: "USD", netTotalEurCents: null }), "ALL_EU_B2C")).toBeNull();
  });
});

describe("ownEurCents BY_PRODUCT", () => {
  it("Belegrabatt nur auf OSS-Anteil", () => {
    const d = doc({
      lines: [line(60000, "ELECTRONIC_SERVICE"), line(40000, null)],
      netTotalCents: 90000,
      documentDiscountPermille: 100,
    });
    expect(ownEurCents(d, "BY_PRODUCT")).toBe(54000);
  });
  it("NONE und Ueberschriften zaehlen nicht", () => {
    expect(ownEurCents(doc({ lines: [line(5000, "NONE")] }), "BY_PRODUCT")).toBe(0);
    expect(ownEurCents(doc({ lines: [line(5000, "GOODS_DISTANCE", "HEADING")] }), "BY_PRODUCT")).toBe(0);
  });
  it("Fremdwaehrung mit und ohne Kurs", () => {
    const lines = [line(12500, "GOODS_DISTANCE")];
    expect(ownEurCents(doc({ currency: "USD", lines, fxRateMicros: 1_250_000 }), "BY_PRODUCT")).toBe(10000);
    expect(ownEurCents(doc({ currency: "USD", lines, fxRateMicros: null }), "BY_PRODUCT")).toBeNull();
  });
  it("Gutschrift mit negativen Zeilen und Rabatt", () => {
    const d = doc({
      type: "CREDIT_NOTE",
      lines: [line(-60000, "ELECTRONIC_SERVICE"), line(-40000, null)],
      netTotalCents: -90000,
      documentDiscountPermille: 100,
    });
    expect(ownEurCents(d, "BY_PRODUCT")).toBe(-54000);
  });
  it("gemischte Vorzeichen: Verhaeltnisrechnung ohne Wurf", () => {
    const d = doc({
      lines: [line(60000, "GOODS_DISTANCE"), line(-10000, null)],
      netTotalCents: 45000,
      documentDiscountPermille: 100,
    });
    // ossRaw 60000, rawSum 50000, netTotal 45000 -> 60000 * 45000 / 50000 = 54000
    expect(ownEurCents(d, "BY_PRODUCT")).toBe(54000);
  });
});

describe("contributionEurCents", () => {
  it("FINAL ALL zieht Abschlaege ab", () => {
    const dp = doc({ type: "DOWNPAYMENT", netTotalEurCents: 30000, netTotalCents: 30000 });
    const fin = doc({ type: "FINAL", netTotalEurCents: 100000, netTotalCents: 100000, deductedDownpaymentIds: [dp.id] });
    expect(contributionEurCents(fin, "ALL_EU_B2C", rel(dp))).toBe(70000);
  });
  it("FINAL ALL mit abweichendem Abschlag-Kurs", () => {
    const dp = doc({ type: "DOWNPAYMENT", currency: "USD", netTotalCents: 33000, netTotalEurCents: 29500, fxRateMicros: 1_118_000 });
    const fin = doc({ type: "FINAL", netTotalEurCents: 100000, deductedDownpaymentIds: [dp.id] });
    expect(contributionEurCents(fin, "ALL_EU_B2C", rel(dp))).toBe(100000 - 29500);
  });
  it("Gutschrift anteilig im BY_PRODUCT", () => {
    const orig = doc({ netTotalEurCents: 100000, netTotalCents: 100000, lines: [line(54000, "GOODS_DISTANCE"), line(46000, null)] });
    const full = doc({ type: "CREDIT_NOTE", correctsInvoiceId: orig.id, netTotalEurCents: -100000, netTotalCents: -100000, lines: [line(-100000, null)] });
    const part = doc({ type: "CREDIT_NOTE", correctsInvoiceId: orig.id, netTotalEurCents: -25000, netTotalCents: -25000, lines: [line(-25000, null)] });
    expect(contributionEurCents(full, "BY_PRODUCT", rel(orig))).toBe(-54000);
    expect(contributionEurCents(part, "BY_PRODUCT", rel(orig))).toBe(-13500);
  });
  it("Gutschrift ohne Original in related -> null (gemeldet statt still 0)", () => {
    const c = doc({ type: "CREDIT_NOTE", correctsInvoiceId: "fehlt", lines: [line(-7000, "GOODS_DISTANCE")], netTotalCents: -7000 });
    expect(contributionEurCents(c, "BY_PRODUCT", none)).toBeNull();
  });
  it("Gutschrift ohne Original in related zaehlt im ALL_EU_B2C den eigenen Betrag", () => {
    const c = doc({ type: "CREDIT_NOTE", correctsInvoiceId: "fehlt", lines: [line(-7000, "GOODS_DISTANCE")], netTotalEurCents: -7000, netTotalCents: -7000 });
    expect(contributionEurCents(c, "ALL_EU_B2C", none)).toBe(-7000);
  });
  it("Original-ALL-Beitrag 0 -> 0", () => {
    const orig = doc({ netTotalEurCents: 0, netTotalCents: 0, lines: [] });
    const c = doc({ type: "CREDIT_NOTE", correctsInvoiceId: orig.id, netTotalEurCents: -5, netTotalCents: -5 });
    expect(contributionEurCents(c, "BY_PRODUCT", rel(orig))).toBe(0);
  });
  it("Storno einer FINAL im BY_PRODUCT kehrt auf 0 zurueck", () => {
    const dp = doc({ type: "DOWNPAYMENT", netTotalEurCents: 30000, netTotalCents: 30000, lines: [line(30000, null)] });
    const fin = doc({
      type: "FINAL", netTotalEurCents: 100000, netTotalCents: 100000,
      lines: [line(100000, "ELECTRONIC_SERVICE")],
      deductedDownpaymentIds: [dp.id],
    });
    const storno = doc({ type: "CREDIT_NOTE", correctsInvoiceId: fin.id, netTotalEurCents: -70000, netTotalCents: -70000, lines: [line(-70000, null)] });
    const r = rel(dp, fin);
    const sum = [dp, fin, storno].reduce((s, d) => s + (contributionEurCents(d, "BY_PRODUCT", r) ?? 0), 0);
    expect(contributionEurCents(fin, "BY_PRODUCT", r)).toBe(100000);
    expect(sum).toBe(0);
  });
});

describe("aggregateOssYear", () => {
  it("filtert und sortiert", () => {
    const docs = [
      doc({ netTotalEurCents: 6000 }),
      doc({ netTotalEurCents: 3000, buyer: { countryCode: "FR", vatId: null } }),
      doc({ netTotalEurCents: 999, buyer: { countryCode: "DE", vatId: null } }),
      doc({ netTotalEurCents: 888, buyer: { countryCode: "AT", vatId: "ATU1" } }),
      doc({ netTotalEurCents: 777, issueDate: new Date("2115-03-01T00:00:00Z") }),
      doc({ currency: "USD", netTotalEurCents: null }),
    ];
    const s = aggregateOssYear(docs, none, "ALL_EU_B2C", 2116);
    expect(s.netEurCents).toBe(9000);
    expect(s.documentCount).toBe(2);
    expect(s.skippedWithoutEur).toBe(1);
    expect(s.byCountry).toEqual([
      { countryCode: "AT", netEurCents: 6000 },
      { countryCode: "FR", netEurCents: 3000 },
    ]);
  });
  it("percent", () => {
    const p = (n: number) => aggregateOssYear([doc({ netTotalEurCents: n })], none, "ALL_EU_B2C", 2116).percent;
    expect(p(950000)).toBe(95);
    expect(p(1500000)).toBe(150);
    expect(p(290000)).toBe(29);
    expect(p(-5)).toBe(0);
  });
});

describe("ossLevel", () => {
  it("Grenzen", () => {
    expect(ossLevel(799_999, 0, 80)).toBe("OK");
    expect(ossLevel(800_000, 0, 80)).toBe("WARN");
    expect(ossLevel(1_000_000, 0, 80)).toBe("WARN");
    expect(ossLevel(1_000_001, 0, 80)).toBe("EXCEEDED");
    expect(ossLevel(0, 1_000_001, 80)).toBe("EXCEEDED");
    expect(ossLevel(700_000, 0, 70)).toBe("WARN");
  });
});

describe("Nachbesserungen Review Task 3", () => {
  it("FINAL im BY_PRODUCT mit kategorisiertem Abschlag", () => {
    const dp = doc({ type: "DOWNPAYMENT", lines: [line(30000, "GOODS_DISTANCE")], netTotalCents: 30000, netTotalEurCents: 30000 });
    const fin = doc({ type: "FINAL", lines: [line(100000, "GOODS_DISTANCE")], netTotalCents: 100000, netTotalEurCents: 100000, deductedDownpaymentIds: [dp.id] });
    expect(contributionEurCents(fin, "BY_PRODUCT", rel(dp))).toBe(70000);
  });
  it("Abschlag ohne EUR oder nicht geladen -> null und skipped", () => {
    const dp = doc({ type: "DOWNPAYMENT", currency: "USD", netTotalEurCents: null, fxRateMicros: null });
    const fin = doc({ type: "FINAL", netTotalEurCents: 100000, deductedDownpaymentIds: [dp.id] });
    expect(contributionEurCents(fin, "ALL_EU_B2C", rel(dp))).toBeNull();
    expect(contributionEurCents(fin, "ALL_EU_B2C", none)).toBeNull();
    const s = aggregateOssYear([fin], rel(dp), "ALL_EU_B2C", 2116);
    expect(s.skippedWithoutEur).toBe(1);
    expect(s.netEurCents).toBe(0);
  });
  it("mulDivRound jenseits 2^53 und ohne -0", () => {
    const orig = doc({ netTotalEurCents: 2_000_000_000_000, netTotalCents: 2_000_000_000_000, lines: [line(1_000_000_000_000, "GOODS_DISTANCE")] });
    const c = doc({ type: "CREDIT_NOTE", correctsInvoiceId: orig.id, netTotalEurCents: -9_000_000_000_000, netTotalCents: -9_000_000_000_000 });
    expect(contributionEurCents(c, "BY_PRODUCT", rel(orig))).toBe(-4_500_000_000_000);
    const orig0 = doc({ netTotalEurCents: 5000, lines: [line(5000, null)] });
    const c0 = doc({ type: "CREDIT_NOTE", correctsInvoiceId: orig0.id, netTotalEurCents: -5000 });
    expect(Object.is(contributionEurCents(c0, "BY_PRODUCT", rel(orig0)), 0)).toBe(true);
  });
  it("documentCount und byCountry ohne Beitrag 0", () => {
    const docs = [
      doc({ lines: [line(5000, "NONE")], netTotalCents: 5000 }),
      doc({ lines: [line(4000, "GOODS_DISTANCE")], netTotalCents: 4000, buyer: { countryCode: "FR", vatId: null } }),
    ];
    const s = aggregateOssYear(docs, none, "BY_PRODUCT", 2116);
    expect(s.documentCount).toBe(1);
    expect(s.byCountry).toEqual([{ countryCode: "FR", netEurCents: 4000 }]);
  });
  it("Jahreszuordnung auf Aggregat-Ebene (Leistung im Vorjahr)", () => {
    const d = doc({ issueDate: new Date("2116-01-05T00:00:00Z"), deliveryDate: new Date("2115-12-20T00:00:00Z"), netTotalEurCents: 4000 });
    expect(aggregateOssYear([d], none, "ALL_EU_B2C", 2115).netEurCents).toBe(4000);
    expect(aggregateOssYear([d], none, "ALL_EU_B2C", 2116).netEurCents).toBe(0);
  });
  it("Gutschrift BY_PRODUCT ohne correctsInvoiceId nutzt eigene Zeilen", () => {
    const c = doc({ type: "CREDIT_NOTE", lines: [line(-3000, "ELECTRONIC_SERVICE")], netTotalCents: -3000 });
    expect(contributionEurCents(c, "BY_PRODUCT", none)).toBe(-3000);
  });
  it("CORRECTION anteilig; Original fehlt -> null", () => {
    const orig = doc({ netTotalEurCents: 100000, netTotalCents: 100000, lines: [line(54000, "GOODS_DISTANCE"), line(46000, null)] });
    const corr = doc({ type: "CORRECTION", correctsInvoiceId: orig.id, netTotalEurCents: -25000, netTotalCents: -25000 });
    expect(contributionEurCents(corr, "BY_PRODUCT", rel(orig))).toBe(-13500);
    expect(contributionEurCents(corr, "BY_PRODUCT", none)).toBeNull();
  });
  it("ALL: Fremdwaehrung ohne EUR-Feld mit Kurs wird umgerechnet", () => {
    expect(ownEurCents(doc({ currency: "USD", netTotalCents: 12500, netTotalEurCents: null, fxRateMicros: 1_250_000 }), "ALL_EU_B2C")).toBe(10000);
  });
});
