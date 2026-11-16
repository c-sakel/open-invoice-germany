import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIncomingXml } from "@/domain/incoming/parse";
import { parseSkontoTerms, skontoSchedule } from "@/domain/incoming/skonto";

describe("parseSkontoTerms", () => {
  it("liest die zwei Stufen der eigenen Ausgabe und behaelt den Freitext", () => {
    const r = parseIncomingXml(readFileSync("test/fixtures/incoming/gen-skonto-two-terms-ubl.xml", "utf8"));
    const p = parseSkontoTerms(r.payment.terms);
    expect(p.terms).toEqual([
      { days: 7, percentBp: 200, basisCents: null },
      { days: 14, percentBp: 100, basisCents: null },
    ]);
    expect(p.freeText).toContain("zahlbar netto bis");
    expect(p.freeText).not.toContain("#SKONTO#");
  });

  it("Prozent mit Nachkommastelle und Basisbetrag", () => {
    expect(parseSkontoTerms("#SKONTO#TAGE=10#PROZENT=2.5#BASISBETRAG=100.00#").terms).toEqual([
      { days: 10, percentBp: 250, basisCents: 10000 },
    ]);
  });

  it("kaputte Zeilen bleiben im Freitext, Freitext ohne Tags bleibt", () => {
    const p = parseSkontoTerms("#SKONTO#TAGE=0#PROZENT=2#\n#SKONTO#TAGE=7#PROZENT=abc#\n#SKONTO#TAGE=366#PROZENT=2#\n#SKONTO#TAGE=5#PROZENT=1#");
    expect(p.terms).toEqual([{ days: 5, percentBp: 100, basisCents: null }]);
    expect(p.freeText).toBe("#SKONTO#TAGE=0#PROZENT=2#\n#SKONTO#TAGE=7#PROZENT=abc#\n#SKONTO#TAGE=366#PROZENT=2#");
    expect(parseSkontoTerms("Zahlbar innerhalb 14 Tagen.")).toEqual({ terms: [], freeText: "Zahlbar innerhalb 14 Tagen." });
    expect(parseSkontoTerms(null)).toEqual({ terms: [], freeText: null });
  });

  it("hoechstens drei Stufen", () => {
    const t = [1, 2, 3, 4].map((d) => `#SKONTO#TAGE=${d}#PROZENT=1#`).join("\n");
    const p = parseSkontoTerms(t);
    expect(p.terms).toHaveLength(3);
    expect(p.freeText).toBe("#SKONTO#TAGE=4#PROZENT=1#");
  });
});

describe("skontoSchedule", () => {
  it("Frist = Rechnungsdatum + Tage, Half-Up in Cent", () => {
    const s = skontoSchedule([{ days: 10, percentBp: 200, basisCents: null }], "2034-06-25", 100005);
    expect(s).toEqual([{ until: "2034-07-05", percentBp: 200, discountCents: 2000, payCents: 98005 }]);
    // 0,5 Cent wird aufgerundet
    expect(skontoSchedule([{ days: 1, percentBp: 50, basisCents: null }], "2034-01-01", 101)[0]?.discountCents).toBe(1);
  });

  it("Basisbetrag hat Vorrang vor dem Zahlbetrag", () => {
    const s = skontoSchedule([{ days: 7, percentBp: 250, basisCents: 10000 }], "2034-06-01", 11900);
    expect(s[0]).toMatchObject({ discountCents: 250, payCents: 11650 });
  });

  it("Basisbetrag groesser als der Zahlbetrag ergibt keine Stufe mit negativem Zahlbetrag", () => {
    const s = skontoSchedule([{ days: 7, percentBp: 5000, basisCents: 100000 }, { days: 14, percentBp: 100, basisCents: null }], "2034-06-01", 11900);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ percentBp: 100 });
    expect(s.every((x) => x.payCents >= 0)).toBe(true);
  });

  it("ohne Datum oder Betrag keine Stufen", () => {
    expect(skontoSchedule([{ days: 7, percentBp: 200, basisCents: null }], null, 1000)).toEqual([]);
    expect(skontoSchedule([{ days: 7, percentBp: 200, basisCents: null }], "2034-06-01", null)).toEqual([]);
  });
});
