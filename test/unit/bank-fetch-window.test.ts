/** Abrufzeitraum, Freigabe-Fristen und Zeitplan des Kontoabrufs (rein). */
import { describe, expect, it } from "vitest";
import { addDays, berlinToday, fetchWindow, nextAutoAt, nextAutoAtFromToday, scaRenewBy, scaWarnDue } from "@/domain/bank-fetch/window";

const base = { today: "2026-11-18", lastFetchedTo: null, firstFetchDays: 30, mode: "AUTO" as const, maxHistoryDays: null };

describe("fetchWindow", () => {
  it("erster Abruf: Standardtage zurueck", () => {
    expect(fetchWindow(base)).toEqual({ from: "2026-10-19", to: "2026-11-18", gapBefore: null });
  });

  it("Folgeabruf: 7 Tage Ueberlappung", () => {
    expect(fetchWindow({ ...base, lastFetchedTo: "2026-11-17" })).toEqual({ from: "2026-11-10", to: "2026-11-18", gapBefore: null });
  });

  it("automatisch hoechstens 89 Tage, die Luecke wird gemeldet", () => {
    const w = fetchWindow({ ...base, lastFetchedTo: "2026-06-01" });
    expect(w.from).toBe(addDays("2026-11-18", -89));
    expect(w.gapBefore).toBe("2026-05-25");
  });

  it("manuell mit Startdatum bis 365 Tage, bis zur Grenze der Bank", () => {
    expect(fetchWindow({ ...base, mode: "MANUAL", manualFrom: "2026-01-01" })).toEqual({ from: "2026-01-01", to: "2026-11-18", gapBefore: null });
    const far = fetchWindow({ ...base, mode: "MANUAL", manualFrom: "2020-01-01" });
    expect(far.from).toBe(addDays("2026-11-18", -365));
    expect(far.gapBefore).toBe("2020-01-01");
    const capped = fetchWindow({ ...base, mode: "MANUAL", manualFrom: "2026-01-01", maxHistoryDays: 90 });
    expect(capped.from).toBe(addDays("2026-11-18", -90));
    expect(capped.gapBefore).toBe("2026-01-01");
  });

  it("manuell ohne Startdatum wie automatisch, nie in der Zukunft", () => {
    expect(fetchWindow({ ...base, mode: "MANUAL", lastFetchedTo: "2026-11-17" }).from).toBe("2026-11-10");
    expect(fetchWindow({ ...base, mode: "MANUAL", manualFrom: "2027-01-01" })).toEqual({ from: "2026-11-18", to: "2026-11-18", gapBefore: null });
  });

  it("der Berliner Tag wechselt um Mitternacht Berliner Zeit", () => {
    expect(berlinToday(new Date("2027-01-10T22:30:00Z"))).toBe("2027-01-10");
    expect(berlinToday(new Date("2027-01-10T23:30:00Z"))).toBe("2027-01-11");
    expect(berlinToday(new Date("2027-07-10T21:30:00Z"))).toBe("2027-07-10");
    expect(berlinToday(new Date("2027-07-10T22:30:00Z"))).toBe("2027-07-11");
    expect(fetchWindow({ ...base, today: berlinToday(new Date("2027-01-10T23:30:00Z")) }).to).toBe("2027-01-11");
  });
});

describe("Freigabe-Frist", () => {
  it("180 Tage nach der letzten Freigabe", () => {
    const sca = new Date("2026-01-01T10:00:00Z");
    expect(scaRenewBy(sca)?.toISOString()).toBe("2026-06-30T10:00:00.000Z");
    expect(scaRenewBy(null)).toBeNull();
  });

  it("Warnung ab Tag 170 (Berliner Tage)", () => {
    const sca = new Date("2026-01-01T10:00:00Z");
    expect(scaWarnDue(sca, new Date("2026-06-19T10:00:00Z"))).toBe(false); // Tag 169
    expect(scaWarnDue(sca, new Date("2026-06-20T10:00:00Z"))).toBe(true); // Tag 170
    expect(scaWarnDue(sca, new Date("2026-06-19T22:30:00Z"))).toBe(true); // Berlin schon der 20.
    expect(scaWarnDue(null, new Date())).toBe(false);
  });
});

describe("Zeitplan in Berliner Zeit", () => {
  it("naechster Berliner Tag zur eingestellten Stunde (Winter und Sommer)", () => {
    expect(nextAutoAt(new Date("2026-12-10T12:00:00Z"), 6).toISOString()).toBe("2026-12-11T05:00:00.000Z");
    expect(nextAutoAt(new Date("2026-07-10T12:00:00Z"), 6).toISOString()).toBe("2026-07-11T04:00:00.000Z");
  });

  it("Zeitumstellung auf Sommerzeit: die Wanduhr zaehlt, nicht die verstrichene Zeit", () => {
    // 28.03.2027: 02:00 -> 03:00. 06:00 Uhr Sommerzeit = 04:00 UTC.
    expect(nextAutoAt(new Date("2027-03-27T12:00:00Z"), 6).toISOString()).toBe("2027-03-28T04:00:00.000Z");
    // Nicht existierende Stunde 02:00 -> erste Stunde danach (03:00 Sommerzeit = 01:00 UTC).
    expect(nextAutoAt(new Date("2027-03-27T12:00:00Z"), 2).toISOString()).toBe("2027-03-28T01:00:00.000Z");
    expect(nextAutoAt(new Date("2027-03-28T12:00:00Z"), 6).toISOString()).toBe("2027-03-29T04:00:00.000Z");
  });

  it("Zeitumstellung auf Winterzeit", () => {
    // 25.10.2026: 03:00 -> 02:00. 06:00 Uhr Winterzeit = 05:00 UTC.
    expect(nextAutoAt(new Date("2026-10-24T12:00:00Z"), 6).toISOString()).toBe("2026-10-25T05:00:00.000Z");
    expect(nextAutoAt(new Date("2026-10-25T12:00:00Z"), 6).toISOString()).toBe("2026-10-26T05:00:00.000Z");
  });

  it("heute, wenn die Stunde noch bevorsteht, sonst morgen", () => {
    expect(nextAutoAtFromToday(new Date("2027-03-28T01:00:00Z"), 6).toISOString()).toBe("2027-03-28T04:00:00.000Z");
    expect(nextAutoAtFromToday(new Date("2027-03-28T05:00:00Z"), 6).toISOString()).toBe("2027-03-29T04:00:00.000Z");
  });
});
