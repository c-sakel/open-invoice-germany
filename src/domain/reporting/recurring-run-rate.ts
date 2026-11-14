/**
 * Monatlich wiederkehrender Nettoumsatz aktiver Abos (Phase 16f, Task 5). Je Abo wird die
 * Summe der Zeilennetti (`computeLineNet`) mit dem Monatsfaktor des Intervalls skaliert und
 * durch `intervalCount` geteilt; gerundet wird EINMAL je Abo (half-up). Nur `status ACTIVE`,
 * je Waehrung eine Zeile (keine Mischung). ACTIVE-Abos mit abgelaufenem `endDate` (vor heute, UTC)
 * zaehlen nicht; Abos mit unbekanntem Intervall werden uebersprungen und in `skipped` gezaehlt.
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";
import { computeLineNet } from "@/lib/pricing/line";

export interface RunRateRow {
  currency: string;
  monthlyNetCents: number;
  activeCount: number;
  /** Aktive Abos mit unbekanntem Intervall, nicht im Betrag enthalten. */
  skipped: number;
}

/** Monatsfaktor je Intervall als Bruch (Zaehler/Nenner), damit nur einmal gerundet wird. */
const MONTH_FACTOR: Record<string, readonly [number, number]> = {
  DAY: [365, 12],
  WEEKLY: [52, 12],
  MONTHLY: [1, 1],
  QUARTERLY: [1, 3],
  YEARLY: [1, 12],
};

export function monthlyRunRateCents(
  lines: { quantityMilli: number; unitNetPriceCents: number; unitNetPriceMilliCents?: number | null; discountPermille: number }[],
  interval: string,
  intervalCount: number,
): number {
  const factor = MONTH_FACTOR[interval];
  if (!factor) throw new Error(`Unbekanntes Intervall: ${interval}`);
  const count = Math.max(1, intervalCount);
  const net = lines.reduce((sum, l) => sum + computeLineNet(l).lineNetCents, 0);
  return roundHalfUp((net * factor[0]) / (factor[1] * count));
}

export async function recurringRunRate(orgId: string, now: Date = new Date()): Promise<RunRateRow[]> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const subs = await dbInternal.recurringInvoice.findMany({
    where: { orgId, status: "ACTIVE", OR: [{ endDate: null }, { endDate: { gte: today } }] },
    select: {
      currency: true,
      interval: true,
      intervalCount: true,
      lines: { select: { quantityMilli: true, unitNetPriceCents: true, unitNetPriceMilliCents: true, discountPermille: true } },
    },
  });
  const rows = new Map<string, RunRateRow>();
  for (const s of subs) {
    const row = rows.get(s.currency) ?? { currency: s.currency, monthlyNetCents: 0, activeCount: 0, skipped: 0 };
    rows.set(s.currency, row);
    if (!MONTH_FACTOR[s.interval]) {
      row.skipped += 1;
      continue;
    }
    row.monthlyNetCents += monthlyRunRateCents(s.lines, s.interval, s.intervalCount);
    row.activeCount += 1;
  }
  return [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
