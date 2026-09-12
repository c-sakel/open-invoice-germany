import { describe, it, expect } from "vitest";
import { advanceDate, intervalLabel, periodRange } from "@/lib/recurring";
import { computeLineNet } from "@/lib/pricing/line";

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("advanceDate (Abo-Stichtage)", () => {
  it("MONTHLY: + 1 Monat", () => {
    expect(iso(advanceDate(new Date("2026-01-15T09:00:00"), "MONTHLY"))).toBe("2026-02-15");
  });

  it("MONTHLY klemmt auf Monatsletzten (31.01. → 28.02.)", () => {
    expect(iso(advanceDate(new Date("2026-01-31T09:00:00"), "MONTHLY"))).toBe("2026-02-28");
  });

  it("QUARTERLY: + 3 Monate über Jahresgrenze", () => {
    expect(iso(advanceDate(new Date("2026-11-15T09:00:00"), "QUARTERLY"))).toBe("2027-02-15");
  });

  it("YEARLY: + 1 Jahr", () => {
    expect(iso(advanceDate(new Date("2026-06-01T09:00:00"), "YEARLY"))).toBe("2027-06-01");
  });

  it("WEEKLY: + 7 Tage", () => {
    expect(iso(advanceDate(new Date("2026-06-01T09:00:00"), "WEEKLY"))).toBe("2026-06-08");
  });

  it("intervalCount: alle 2 Monate", () => {
    expect(iso(advanceDate(new Date("2026-01-15T09:00:00"), "MONTHLY", 2))).toBe("2026-03-15");
  });

  it("anchorDay fixiert den Tag", () => {
    expect(iso(advanceDate(new Date("2026-01-15T09:00:00"), "MONTHLY", 1, 1))).toBe("2026-02-01");
  });

  it("Label spiegelt Rhythmus", () => {
    expect(intervalLabel("MONTHLY")).toBe("monatlich");
    expect(intervalLabel("MONTHLY", 2)).toBe("alle 2 Monate");
  });
});

// Phase 14a, Task 1 (R4): periodRange() liefert die Periodengrenzen zu einem Stichtag —
// start = ein Intervall VOR dem Stichtag (advanceDate mit negativem Faktor), end = der
// Stichtag selbst (unveraendert).
describe("periodRange (Abo-Periodengrenzen)", () => {
  it("MONTHLY mit Anker 31 -> Periodenbeginn klemmt auf Februar-Letzten", () => {
    // Stichtag 31.03. (MONTHLY, Anker 31): ein Monat davor waere der 31.02., klemmt auf 28.02.
    const { start, end } = periodRange(new Date("2026-03-31T12:00:00"), "MONTHLY", 1, 31);
    expect(iso(start)).toBe("2026-02-28");
    expect(iso(end)).toBe("2026-03-31");
  });

  it("WEEKLY: Periodenbeginn liegt 7 Tage vor dem Stichtag", () => {
    const { start, end } = periodRange(new Date("2026-06-08T12:00:00"), "WEEKLY", 1);
    expect(iso(start)).toBe("2026-06-01");
    expect(iso(end)).toBe("2026-06-08");
  });

  it("QUARTERLY: Periodenbeginn liegt 3 Monate vor dem Stichtag (ueber die Jahresgrenze)", () => {
    const { start, end } = periodRange(new Date("2027-02-15T12:00:00"), "QUARTERLY", 1);
    expect(iso(start)).toBe("2026-11-15");
    expect(iso(end)).toBe("2027-02-15");
  });

  it("YEARLY: Periodenbeginn liegt 1 Jahr vor dem Stichtag", () => {
    const { start, end } = periodRange(new Date("2027-06-01T12:00:00"), "YEARLY", 1);
    expect(iso(start)).toBe("2026-06-01");
    expect(iso(end)).toBe("2027-06-01");
  });

  it("intervalCount > 1: alle 2 Monate -> Periodenbeginn liegt 2 Monate zurueck", () => {
    const { start, end } = periodRange(new Date("2026-03-15T12:00:00"), "MONTHLY", 2);
    expect(iso(start)).toBe("2026-01-15");
    expect(iso(end)).toBe("2026-03-15");
  });

  // Fix-Welle 1 (should): Schaltjahr-Stichtag 29.02. mit Ankertag 31 — ein Monat zurueck
  // ist Januar (31 Tage, klemmt nicht), speist seit Task 1 auch BG-14 (deliveryStart/-End).
  it("Schaltjahr: Stichtag 29.02.2028 (MONTHLY, Anker 31) -> Periodenbeginn 31.01.2028", () => {
    const { start, end } = periodRange(new Date("2028-02-29T12:00:00"), "MONTHLY", 1, 31);
    expect(iso(start)).toBe("2028-01-31");
    expect(iso(end)).toBe("2028-02-29");
  });
});

// W4: src/domain/recurring/run.ts nutzt seit der Fix-Welle dieselbe Rundung wie die
// manuelle Rechnung (computeLineNet aus src/lib/pricing/line.ts) statt der separat
// gerundeten computeLineNetCents (entfernt aus src/lib/money.ts). Fuer 2,5 x 1,01 EUR
// mit 33,3 % Rabatt lieferten beide Wege vorher unterschiedliche Cent-Werte (168 vs. 169).
describe("W4 — Abo-Lauf und manuelle Rechnung runden identisch", () => {
  it("2,5 x 1,01 EUR mit 33,3 % Rabatt ergibt denselben Cent-Wert", () => {
    const result = computeLineNet({ quantityMilli: 2500, unitNetPriceCents: 101, discountPermille: 333 });
    expect(result.lineNetCents).toBe(169);
  });
});
