export type FxRow = { source: "ECB" | "MONTHLY"; currency: string; rateDate: Date; rateMicros: number };
export type FxPick = { rateMicros: number; rateDate: Date; source: "ECB_DAILY" | "BMF_MONTHLY" };

const DAY_MS = 86_400_000;
const ECB_WINDOW_DAYS = 7;

const utcDay = (d: Date): number => Math.floor(d.getTime() / DAY_MS);
const monthIndex = (d: Date): number => d.getUTCFullYear() * 12 + d.getUTCMonth();

/** Stichtag fuer die Kurswahl: Leistungs-/Lieferdatum, sonst Leistungsende, sonst Rechnungsdatum. */
export function fxStichtag(inv: { deliveryDate: Date | null; deliveryEnd: Date | null; issueDate: Date }): Date {
  return inv.deliveryDate ?? inv.deliveryEnd ?? inv.issueDate;
}

/**
 * ECB_DAILY: juengster Kurs am oder vor dem Stichtag, hoechstens 7 Tage alt.
 * BMF_MONTHLY: Konvention: eine Monatszeile ist auf den 1. des Monats datiert (rateDate = 1.).
 * Monatskurs des Stichtagsmonats, sonst exakt des Vormonats. Sonst null.
 *
 * Vorausrechnung (`now` gesetzt, Stichtag in der Zukunft): ECB_DAILY nimmt den juengsten Tageskurs
 * am oder vor `now` (7-Tage-Fenster relativ zu `now`); BMF_MONTHLY, wenn der Stichtagsmonat nach dem
 * Monat von `now` liegt, den juengsten Monatskurs bis einschliesslich Monat von `now` (der Monat steht
 * auf dem Beleg wie beim Vormonat-Fallback; offener Punkt fuer den Steuerberater, COMPLIANCE.md).
 */
export function pickRate(
  rows: FxRow[],
  currency: string,
  stichtag: Date,
  mode: "ECB_DAILY" | "BMF_MONTHLY",
  now?: Date,
): FxPick | null {
  const wanted = mode === "ECB_DAILY" ? "ECB" : "MONTHLY";
  const cand = rows.filter((r) => r.source === wanted && r.currency === currency);
  if (mode === "ECB_DAILY") {
    const day = utcDay(now && stichtag.getTime() > now.getTime() ? now : stichtag);
    let best: FxRow | null = null;
    for (const r of cand) {
      const rd = utcDay(r.rateDate);
      if (rd > day || day - rd > ECB_WINDOW_DAYS) continue;
      if (!best || r.rateDate.getTime() > best.rateDate.getTime()) best = r;
    }
    return best ? { rateMicros: best.rateMicros, rateDate: best.rateDate, source: "ECB_DAILY" } : null;
  }
  if (now && monthIndex(stichtag) > monthIndex(now)) {
    const latest = cand
      .filter((r) => monthIndex(r.rateDate) <= monthIndex(now))
      .sort((a, b) => b.rateDate.getTime() - a.rateDate.getTime())[0];
    return latest ? { rateMicros: latest.rateMicros, rateDate: latest.rateDate, source: "BMF_MONTHLY" } : null;
  }
  const cur = monthIndex(stichtag);
  for (const target of [cur, cur - 1]) {
    const hit = cand
      .filter((r) => monthIndex(r.rateDate) === target && r.rateDate.getTime() <= stichtag.getTime())
      .sort((a, b) => b.rateDate.getTime() - a.rateDate.getTime())[0];
    if (hit) return { rateMicros: hit.rateMicros, rateDate: hit.rateDate, source: "BMF_MONTHLY" };
  }
  return null;
}
