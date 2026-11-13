/**
 * Umsatzreihe je Kalendermonat (Phase 12e). Rein lesend, org-gescoped, DB-portabel:
 * `select`-reduzierte Zeilen + Aggregation in JS — dieselbe Begruendung wie in
 * src/domain/dashboard/summary.ts (SQLite/Postgres, keine DB-spezifischen Funktionen).
 * Monatsgrenzen nach Berliner Kalendermonat (src/lib/berlin-time.ts), unabhaengig von der
 * Container-Zeitzone. Date-only-Werte (UTC-Mitternacht) bleiben im selben Monat.
 *
 * Basis ist NETTO. Bei einer Abschlagskette (§14) traegt die Schlussrechnung in
 * `payableCents` den bereits um die Abschlaege reduzierten Betrag; ein rohes
 * `netTotalCents` wuerde den Abschlag doppelt zaehlen (derselbe Fehler, den die Fix-Welle
 * S2 fuer `grossTotalCents` behoben hat, siehe src/domain/dashboard/summary.ts). Deshalb
 * skaliert `netShareCents` proportional zum Anteil von `payableCents` an `grossTotalCents`
 * (Ruling Task-2, dokumentiert in docs/ARCHITEKTUR.md).
 *
 * Vorzeichen-NORMALISIERUNG statt -DREHUNG (Fix I2, Abschluss-Review): Gutschriften/Stornos,
 * die über die Domain-Funktionen entstehen (`createPartialCreditNote`, `cancelInvoice` —
 * src/domain/invoice/credit.ts bzw. cancel.ts), tragen bereits NEGATIVE `netTotalCents`/
 * `grossTotalCents` (betragsspiegelbildlich zum Original). Der Editor erlaubt aber auch eine
 * FREISTEHENDE Gutschrift (`type: "CREDIT_NOTE"` in `createDraftInvoice`, kein Vorzeichenzwang
 * in `createInvoiceSchema.unitNetPriceCents`) — mit der naheliegenden Eingabe positiver
 * Positionsbeträge. `signedRevenueShareCents` normalisiert deshalb: bei `type === "CREDIT_NOTE"`
 * wird der Betrag per `-Math.abs(...)` auf negativ gezwungen (idempotent für die bereits
 * negativen Domain-Gutschriften — `-Math.abs` einer negativen Zahl ändert nichts), NICHT per
 * `-1`-Multiplikation (das hätte eine echte Gutschrift ein zweites Mal negiert und den
 * ausgewiesenen Umsatz erhöht statt gemindert — der ursprüngliche Fehler vor Fix 1).
 *
 * Statusfilter schließt NUR `DRAFT` aus (nicht `CANCELLED`): das stornierte Original bleibt
 * unverändert (GoBD) und zählt weiterhin mit vollem Betrag in seinem Ausstellungsmonat; die
 * Storno-Gutschrift mindert separat den Monat der Stornierung (`issueDate` der Gutschrift =
 * Stornozeitpunkt). Über die Zeit gesehen gleichen sich beide genau aus — eine periodengerechte
 * (accrual) Sicht, kein "Original raus, Storno rein" mit potenziell negativem Netto in einem
 * einzelnen Monat, falls Original und Storno in unterschiedliche Monate fallen.
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";
import { berlinMonthKey, berlinMonthStart } from "@/lib/berlin-time";

export interface MonthlyRevenuePoint {
  month: string; // "YYYY-MM" (Berlin)
  netCents: number;
  count: number;
}

export interface MonthlyRevenueOptions {
  months?: number;
  customerId?: string;
  /** Nur Belege dieser Waehrung (Dashboard: Standardwaehrung); ohne Angabe alle (Mischsumme!). */
  currency?: string;
  now?: Date;
}

/** Kalendermonat (Europe/Berlin) von `d` als "YYYY-MM". */
export function monthKey(d: Date): string {
  return berlinMonthKey(d);
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
 * `netShareCents` plus Vorzeichen-Normalisierung (Fix I2): bei `type === "CREDIT_NOTE"` wird
 * der Anteil per `-Math.abs(...)` auf negativ gezwungen statt gedreht — idempotent für
 * Domain-Gutschriften (bereits negativ), korrigiert aber eine freistehend mit positiven
 * Beträgen angelegte Gutschrift. Gemeinsam genutzt von `monthlyRevenue` und `topCustomers`
 * (kein zweites Vorzeichenverfahren, §1.4).
 */
export function signedRevenueShareCents(inv: {
  netTotalCents: number;
  grossTotalCents: number;
  payableCents: number | null;
  type: string;
}): number {
  const share = netShareCents(inv);
  return inv.type === "CREDIT_NOTE" ? -Math.abs(share) : share;
}

/**
 * Umsatzreihe der letzten `months` Kalendermonate (Default 12, inklusive des Monats von
 * `now`), luecklos (auch Monate ohne Beleg als 0-Eintrag). Nur `status !== "DRAFT"` (siehe
 * Modulkommentar zu CANCELLED); Beträge laufen durch `signedRevenueShareCents` (Fix I2:
 * Vorzeichen-Normalisierung bei `type === "CREDIT_NOTE"`, siehe Modulkommentar).
 */
export async function monthlyRevenue(orgId: string, opts: MonthlyRevenueOptions = {}): Promise<MonthlyRevenuePoint[]> {
  const months = opts.months ?? 12;
  const now = opts.now ?? new Date();
  const end = berlinMonthStart(now, 1);
  const start = berlinMonthStart(now, -(months - 1));

  const rows = await dbInternal.invoice.findMany({
    where: {
      orgId,
      status: { not: "DRAFT" },
      issueDate: { gte: start, lt: end },
      ...(opts.customerId ? { customerId: opts.customerId } : {}),
      ...(opts.currency ? { currency: opts.currency } : {}),
    },
    select: { issueDate: true, netTotalCents: true, grossTotalCents: true, payableCents: true, type: true },
  });

  const buckets = new Map<string, MonthlyRevenuePoint>();
  for (let i = 0; i < months; i++) {
    const key = berlinMonthKey(berlinMonthStart(now, -(months - 1) + i));
    buckets.set(key, { month: key, netCents: 0, count: 0 });
  }
  for (const r of rows) {
    const bucket = buckets.get(monthKey(r.issueDate));
    if (!bucket) continue;
    bucket.netCents += signedRevenueShareCents(r);
    bucket.count += 1;
  }
  return [...buckets.values()];
}
