/** Rechenkern der Umsatzgrenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG). */
import { describe, it, expect } from "vitest";
import {
  aggregateKuYear,
  kuLevel,
  netEurOf,
  paymentNetEurCents,
  type KuDoc,
  type KuPayment,
  type KuYearSum,
} from "@/domain/reporting/ku-calc";

const D = (iso: string) => new Date(iso);
const doc = (id: string, o: Partial<KuDoc> = {}): KuDoc => ({
  id, type: "INVOICE", taxScheme: "KLEINUNTERNEHMER", currency: "EUR", issueDate: D("2200-03-10T10:00:00Z"),
  netTotalCents: 10000, grossTotalCents: 10000, netTotalEurCents: null, ...o,
});
const pay = (invoiceId: string, amountCents: number, o: Partial<KuPayment> = {}): KuPayment => ({
  invoiceId, amountCents, paidAt: D("2200-04-01T10:00:00Z"), isSkonto: false, method: "TRANSFER", ...o,
});
const sum = (year: number, o: Partial<KuYearSum> = {}): KuYearSum => ({
  year, receivedCents: 0, invoicedCents: 0, externalCents: 0, totalReceivedCents: 0, totalInvoicedCents: 0, documentCount: 0, skippedWithoutEur: 0, ...o,
});
const withReceived = (year: number, cents: number, invoiced = cents) =>
  sum(year, { receivedCents: cents, totalReceivedCents: cents, invoicedCents: invoiced, totalInvoicedCents: invoiced });
const level = (cur: KuYearSum, prev: KuYearSum = sum(2199), o: { warnPercent?: number; startYear?: number | null } = {}) =>
  kuLevel({ current: cur, previous: prev, warnPercent: o.warnPercent ?? 80, startYear: o.startYear ?? null });

describe("kuLevel", () => {
  it("genau 25.000,00 EUR vereinnahmt: kein Verlust fuer das Folgejahr, aber Warnung", () => {
    const r = level(withReceived(2200, 2_500_000));
    expect(r.level).toBe("WARN");
    expect(r.reasons).toContain("APPROACHING_NEXT_YEAR_LIMIT");
    expect(r.currentLimitCents).toBe(10_000_000);
  });
  it("25.000,01 EUR vereinnahmt: NEXT_YEAR_LOST", () => {
    const r = level(withReceived(2200, 2_500_001));
    expect(r.level).toBe("NEXT_YEAR_LOST");
    expect(r.reasons).toEqual(["CURRENT_OVER_25000"]);
  });
  it("100.000,00 EUR ist nicht EXCEEDED, 100.000,01 EUR schon", () => {
    expect(level(withReceived(2200, 10_000_000)).level).toBe("NEXT_YEAR_LOST");
    const r = level(withReceived(2200, 10_000_001));
    expect(r.level).toBe("EXCEEDED");
    expect(r.reasons).toContain("CURRENT_OVER_LIMIT");
  });
  it("Vorjahr ueber 25.000,00 EUR: EXCEEDED mit PREVIOUS_OVER_25000", () => {
    expect(level(sum(2200), withReceived(2199, 2_500_000)).level).toBe("OK");
    const r = level(sum(2200), withReceived(2199, 2_500_001));
    expect(r.level).toBe("EXCEEDED");
    expect(r.reasons).toEqual(["PREVIOUS_OVER_25000"]);
  });
  it("Gruendungsjahr: Grenze 25.000 EUR, Vorjahr wird ignoriert", () => {
    const prev = withReceived(2199, 9_000_000);
    expect(level(withReceived(2200, 100), prev, { startYear: 2200 }).level).toBe("OK");
    const r = level(withReceived(2200, 2_500_001), prev, { startYear: 2200 });
    expect(r.level).toBe("EXCEEDED");
    expect(r.currentLimitCents).toBe(2_500_000);
    expect(r.reasons).toEqual(["CURRENT_OVER_LIMIT"]);
  });
  it("nur berechnet ueber der Grenze: WARN mit INVOICED_OVER_LIMIT", () => {
    const r = level(sum(2200, { invoicedCents: 10_000_001, totalInvoicedCents: 10_000_001 }));
    expect(r.level).toBe("WARN");
    expect(r.reasons).toContain("INVOICED_OVER_LIMIT");
  });
  it("Warnschwelle 80 % exakt erreicht (20.000,00 EUR) warnt, ein Cent darunter nicht", () => {
    expect(level(withReceived(2200, 2_000_000)).level).toBe("WARN");
    expect(level(withReceived(2200, 1_999_999)).level).toBe("OK");
    expect(level(withReceived(2200, 2_000_000), sum(2199), { warnPercent: 90 }).level).toBe("OK");
  });
  it("Fremdumsatz in den Summen zaehlt mit", () => {
    const cur = sum(2200, { receivedCents: 100, totalReceivedCents: 2_500_100, externalCents: 2_500_000 });
    expect(level(cur).level).toBe("NEXT_YEAR_LOST");
  });
});

describe("paymentNetEurCents", () => {
  it("Nettoanteil: 59,50 auf 119,00 brutto / 100,00 netto = 50,00", () => {
    const d = doc("a", { netTotalCents: 10000, grossTotalCents: 11900 });
    expect(paymentNetEurCents(pay("a", 5950), d)).toBe(5000);
  });
  it("Half-Up (halb weg von null) bei Rundung", () => {
    const d = doc("a", { netTotalCents: 10000, grossTotalCents: 11900 });
    expect(paymentNetEurCents(pay("a", 1), d)).toBe(1); // 0,84 -> 1
    expect(paymentNetEurCents(pay("a", 5), d)).toBe(4); // 4,2 -> 4
    expect(paymentNetEurCents(pay("a", -1), d)).toBe(-1);
    const half = doc("h", { netTotalCents: 1, grossTotalCents: 2 });
    expect(paymentNetEurCents(pay("h", 1), half)).toBe(1); // 0,5 -> 1
    expect(paymentNetEurCents(pay("h", -1), half)).toBe(-1);
  });
  it("Brutto 0 ergibt 0; Fremdwaehrung ohne EUR-Wert ergibt null", () => {
    expect(paymentNetEurCents(pay("a", 100), doc("a", { grossTotalCents: 0 }))).toBe(0);
    expect(paymentNetEurCents(pay("u", 100), doc("u", { currency: "USD" }))).toBeNull();
  });
});

describe("netEurOf", () => {
  it("EUR direkt, Fremdwaehrung ueber netTotalEurCents", () => {
    expect(netEurOf(doc("a", { netTotalCents: 123 }))).toBe(123);
    expect(netEurOf(doc("u", { currency: "USD", netTotalCents: 500, netTotalEurCents: 460 }))).toBe(460);
    expect(netEurOf(doc("u", { currency: "USD", netTotalCents: 500 }))).toBeNull();
  });
});

describe("aggregateKuYear", () => {
  it("trennt vereinnahmt und berechnet", () => {
    const docs = [doc("a", { netTotalCents: 100000, grossTotalCents: 100000 })];
    const s = aggregateKuYear(docs, [pay("a", 40000)], {}, 2200);
    expect(s.invoicedCents).toBe(100000);
    expect(s.receivedCents).toBe(40000);
    expect(s.documentCount).toBe(1);
  });
  it("Gegenbuchung mindert, Skonto und Verrechnung per Gutschrift zaehlen nicht", () => {
    const docs = [doc("a")];
    const s = aggregateKuYear(
      docs,
      [pay("a", 10000), pay("a", -4000, { paidAt: D("2200-05-01T10:00:00Z") }), pay("a", 300, { isSkonto: true }), pay("a", 500, { method: "SKONTO" }), pay("a", 900, { method: "CREDIT_NOTE" })],
      {},
      2200,
    );
    expect(s.receivedCents).toBe(6000);
  });
  it("Gutschrift mindert den berechneten Umsatz (positiv oder negativ gespeichert)", () => {
    const docs = [doc("a", { netTotalCents: 10000 }), doc("g", { type: "CREDIT_NOTE", netTotalCents: -2500 }), doc("g2", { type: "CREDIT_NOTE", netTotalCents: 500 })];
    expect(aggregateKuYear(docs, [], {}, 2200).invoicedCents).toBe(7000);
  });
  it("Schemata ohne Inlandsumsatz ausgeschlossen, IG_LIEFERUNG und AUSFUHR gezaehlt", () => {
    const docs = [
      doc("a", { taxScheme: "IG_LEISTUNG" }), doc("b", { taxScheme: "NICHT_STEUERBAR" }),
      doc("c", { taxScheme: "IG_LIEFERUNG" }), doc("d", { taxScheme: "AUSFUHR" }),
    ];
    const s = aggregateKuYear(docs, docs.map((d) => pay(d.id, 10000)), {}, 2200);
    expect(s.invoicedCents).toBe(20000);
    expect(s.receivedCents).toBe(20000);
  });
  it("Fremdwaehrung: mit EUR-Wert gezaehlt, ohne EUR-Wert gemeldet", () => {
    const docs = [
      doc("u1", { currency: "USD", netTotalCents: 1000, grossTotalCents: 1000, netTotalEurCents: 900 }),
      doc("u2", { currency: "USD", netTotalCents: 1000, grossTotalCents: 1000 }),
    ];
    const s = aggregateKuYear(docs, [pay("u1", 1000), pay("u2", 1000)], {}, 2200);
    expect(s.invoicedCents).toBe(900);
    expect(s.receivedCents).toBe(900);
    expect(s.skippedWithoutEur).toBe(1);
  });
  it("Zahlung am 31.12. 23:30 UTC zaehlt ins Berliner Folgejahr", () => {
    const docs = [doc("a")];
    const p = pay("a", 10000, { paidAt: D("2200-12-31T23:30:00Z") });
    expect(aggregateKuYear(docs, [p], {}, 2200).receivedCents).toBe(0);
    expect(aggregateKuYear(docs, [p], {}, 2201).receivedCents).toBe(10000);
  });
  it("Fremdumsatz wird je Jahr addiert", () => {
    const s = aggregateKuYear([], [], { "2200": 123456 }, 2200);
    expect(s.externalCents).toBe(123456);
    expect(s.totalReceivedCents).toBe(123456);
    expect(s.totalInvoicedCents).toBe(123456);
    expect(aggregateKuYear([], [], { "2200": 123456 }, 2201).externalCents).toBe(0);
  });
  it("Schlussrechnung: nur der noch nicht berechnete Anteil", () => {
    const docs = [doc("f", { type: "FINAL", netTotalCents: 10000, grossTotalCents: 11900, payableCents: 5950 })];
    expect(aggregateKuYear(docs, [], {}, 2200).invoicedCents).toBe(5000);
  });
  it("Ergebnis ist unabhaengig von der Eingabereihenfolge", () => {
    const docs = [doc("a", { netTotalCents: 11900, grossTotalCents: 14161 }), doc("b"), doc("c", { currency: "USD", netTotalEurCents: 777, grossTotalCents: 900 })];
    const ps = [pay("a", 7001), pay("b", 3333), pay("c", 450), pay("a", -11)];
    const a = aggregateKuYear(docs, ps, {}, 2200);
    const b = aggregateKuYear([...docs].reverse(), [...ps].reverse(), {}, 2200);
    expect(b).toEqual(a);
  });
});
