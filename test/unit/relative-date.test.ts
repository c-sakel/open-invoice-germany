/**
 * Phase 13a, Task 2 — `relativeDueLabel` fuer Listen/Belegansicht. Bewusst reine
 * Tagesdifferenz (nicht Intl.RelativeTimeFormat) ueber die Tagesgrenzen-Konvention aus
 * src/lib/date-only.ts (dieselbe wie effectiveInvoiceStatus/listInvoices/dunning) — der
 * Test laeuft daher unter UTC UND Europe/Berlin (Gate-Vorgabe) gleich durch.
 */
import { describe, it, expect } from "vitest";
import { relativeDueLabel } from "@/lib/relative-date";

const NOW = new Date(Date.UTC(2064, 2, 15, 9, 30));
function d(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day));
}

describe("relativeDueLabel (Phase 13a, Task 2)", () => {
  it("heute faellig", () => {
    expect(relativeDueLabel(d(2064, 2, 15), NOW)).toEqual({ text: "heute fällig", overdue: false, days: 0 });
  });

  it("morgen faellig", () => {
    expect(relativeDueLabel(d(2064, 2, 16), NOW).text).toBe("morgen fällig");
  });

  it("in N Tagen (N > 1)", () => {
    expect(relativeDueLabel(d(2064, 2, 29), NOW).text).toBe("in 14 Tagen");
  });

  it("seit 1 Tag ueberfaellig", () => {
    expect(relativeDueLabel(d(2064, 2, 14), NOW)).toEqual({ text: "seit 1 Tag überfällig", overdue: true, days: -1 });
  });

  it("seit N Tagen ueberfaellig (N > 1)", () => {
    expect(relativeDueLabel(d(2064, 2, 12), NOW).text).toBe("seit 3 Tagen überfällig");
  });

  it("kein Faelligkeitsdatum", () => {
    expect(relativeDueLabel(null, NOW)).toEqual({ text: "—", overdue: false, days: null });
  });

  it("Jahreswechsel", () => {
    expect(relativeDueLabel(d(2065, 0, 2), new Date(Date.UTC(2064, 11, 31, 23, 0))).text).toBe("in 2 Tagen");
  });

  it("Tagesrand (23:59 desselben Kalendertags zaehlt als heute)", () => {
    expect(relativeDueLabel(d(2064, 2, 15), new Date(Date.UTC(2064, 2, 15, 23, 59))).days).toBe(0);
  });
});
