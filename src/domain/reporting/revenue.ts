/**
 * Umsatzreihe je Kalendermonat (Phase 12e). Rein lesend, org-gescoped, DB-portabel:
 * `select`-reduzierte Zeilen + Aggregation in JS — dieselbe Begruendung wie in
 * src/domain/dashboard/summary.ts (SQLite/Postgres, keine DB-spezifischen Funktionen).
 * Monatsgrenzen in UTC (Date.UTC), damit die Reihe unabhaengig von der Container-Zeitzone
 * ist (Konvention aus src/lib/date-only.ts).
 *
 * Basis ist NETTO. Bei einer Abschlagskette (§14) traegt die Schlussrechnung in
 * `payableCents` den bereits um die Abschlaege reduzierten Betrag; ein rohes
 * `netTotalCents` wuerde den Abschlag doppelt zaehlen (derselbe Fehler, den die Fix-Welle
 * S2 fuer `grossTotalCents` behoben hat, siehe src/domain/dashboard/summary.ts). Deshalb
 * skaliert `netShareCents` proportional zum Anteil von `payableCents` an `grossTotalCents`
 * (Ruling Task-2, dokumentiert in docs/ARCHITEKTUR.md).
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";

export interface MonthlyRevenuePoint {
  month: string; // "YYYY-MM" (UTC)
  netCents: number;
  count: number;
}

export interface MonthlyRevenueOptions {
  months?: number;
  customerId?: string;
  now?: Date;
}

/** Kalendermonat (UTC) von `d` als "YYYY-MM". */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Netto-Bemessungsgrundlage einer Rechnung fuer Auswertungen. Ohne `payableCents`
 * (Normalfall) schlicht `netTotalCents`; traegt die Rechnung `payableCents` (Schlussrechnung
 * einer Abschlagskette, §14), wird `netTotalCents` proportional zum Verhaeltnis
 * `payableCents / grossTotalCents` skaliert — damit summiert eine Abschlags- plus
 * Schlussrechnung genau den Netto-Auftragswert, ohne den Abschlag doppelt zu zaehlen.
 * `grossTotalCents === 0` liefert 0 (keine sinnvolle Bezugsgroesse fuer die Aufteilung).
 */
export function netShareCents(inv: { netTotalCents: number; grossTotalCents: number; payableCents: number | null }): number {
  if (inv.payableCents === null) return inv.netTotalCents;
  if (inv.grossTotalCents === 0) return 0;
  return roundHalfUp((inv.netTotalCents * inv.payableCents) / inv.grossTotalCents);
}

/**
 * Umsatzreihe der letzten `months` Kalendermonate (Default 12, inklusive des Monats von
 * `now`), luecklos (auch Monate ohne Beleg als 0-Eintrag). Nur festgeschriebene Belege
 * (`status` weder DRAFT noch CANCELLED); Gutschriften (`type: CREDIT_NOTE`) gehen mit
 * negativem Vorzeichen ein.
 */
export async function monthlyRevenue(orgId: string, opts: MonthlyRevenueOptions = {}): Promise<MonthlyRevenuePoint[]> {
  const months = opts.months ?? 12;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const rows = await dbInternal.invoice.findMany({
    where: {
      orgId,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: start, lt: end },
      ...(opts.customerId ? { customerId: opts.customerId } : {}),
    },
    select: { issueDate: true, type: true, netTotalCents: true, grossTotalCents: true, payableCents: true },
  });

  const buckets = new Map<string, MonthlyRevenuePoint>();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    buckets.set(monthKey(d), { month: monthKey(d), netCents: 0, count: 0 });
  }
  for (const r of rows) {
    const bucket = buckets.get(monthKey(r.issueDate));
    if (!bucket) continue;
    const sign = r.type === "CREDIT_NOTE" ? -1 : 1;
    bucket.netCents += sign * netShareCents(r);
    bucket.count += 1;
  }
  return [...buckets.values()];
}
