import { describe, it, expect } from "vitest";
import { fxStichtag } from "@/domain/fx/pick-rate";
import { ossYearOf } from "@/domain/reporting/oss-calc";

const d = (s: string) => new Date(`${s}T10:00:00.000Z`);

describe("fxStichtag (R4)", () => {
  it("deliveryDate gesetzt -> deliveryDate", () => {
    expect(fxStichtag({ deliveryDate: d("2261-03-01"), deliveryEnd: d("2261-03-05"), issueDate: d("2261-03-10") })).toEqual(d("2261-03-01"));
  });
  it("nur Ende am oder vor dem Rechnungsdatum -> Ende", () => {
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: d("2261-03-05"), issueDate: d("2261-03-10") })).toEqual(d("2261-03-05"));
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: d("2261-03-10"), issueDate: d("2261-03-10") })).toEqual(d("2261-03-10"));
  });
  it("Ende nach dem Rechnungsdatum (Vorausrechnung) -> Rechnungsdatum", () => {
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: d("2262-11-24"), issueDate: d("2261-11-25") })).toEqual(d("2261-11-25"));
  });
  it("Vergleich nach Berliner Kalendertag, nicht nach Uhrzeit", () => {
    const issue = new Date("2261-03-10T08:00:00.000Z");
    const end = new Date("2261-03-10T20:00:00.000Z");
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: end, issueDate: issue })).toEqual(end);
  });
  it("nichts gesetzt -> Rechnungsdatum", () => {
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: null, issueDate: d("2261-03-10") })).toEqual(d("2261-03-10"));
  });
});

describe("ossYearOf bei Vorausrechnung", () => {
  it("ADVANCE-Rechnung 25.11.2261 mit Ende 2262 zählt im Jahr 2261", () => {
    const doc = { deliveryDate: null, deliveryEnd: d("2262-11-24"), issueDate: d("2261-11-25"), buyer: null } as unknown as Parameters<typeof ossYearOf>[0];
    expect(ossYearOf(doc)).toBe(2261);
  });
});
