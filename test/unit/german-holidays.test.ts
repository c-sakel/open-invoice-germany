import { describe, expect, it } from "vitest";
import { easterSunday, isNationalHoliday, nextBusinessDay } from "@/lib/german-holidays";

const u = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("Feiertage", () => {
  it("Ostersonntag bekannter Jahre", () => {
    expect(iso(easterSunday(2024))).toBe("2024-03-31");
    expect(iso(easterSunday(2025))).toBe("2025-04-20");
    expect(iso(easterSunday(2026))).toBe("2026-04-05");
    expect(iso(easterSunday(2027))).toBe("2027-03-28");
  });
  it("bewegliche Feiertage 2026", () => {
    for (const [m, d] of [[4, 3], [4, 6], [5, 14], [5, 25]] as const) expect(isNationalHoliday(u(2026, m, d))).toBe(true);
    expect(isNationalHoliday(u(2026, 4, 7))).toBe(false);
  });
  it("feste Feiertage, 24.12. und 31.12. keine", () => {
    for (const [m, d] of [[1, 1], [5, 1], [10, 3], [12, 25], [12, 26]] as const) expect(isNationalHoliday(u(2026, m, d))).toBe(true);
    expect(isNationalHoliday(u(2026, 12, 24))).toBe(false);
    expect(isNationalHoliday(u(2026, 12, 31))).toBe(false);
    expect(isNationalHoliday(u(2026, 11, 1))).toBe(false); // Allerheiligen nur Landesfeiertag
  });
  it("nextBusinessDay: Werktag bleibt, Wochenende und Feiertagsketten springen", () => {
    expect(iso(nextBusinessDay(u(2026, 3, 4)))).toBe("2026-03-04");
    expect(iso(nextBusinessDay(u(2026, 4, 3)))).toBe("2026-04-07"); // Karfreitag, Sa, So, Ostermontag
    expect(iso(nextBusinessDay(u(2026, 12, 25)))).toBe("2026-12-28"); // Fr, Sa, So
    expect(iso(nextBusinessDay(u(2027, 1, 1)))).toBe("2027-01-04"); // Fr Neujahr, Sa, So
  });
});
