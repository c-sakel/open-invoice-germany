/**
 * Kurswahl fuer einen Beleg: liest die Kursquelle der Organisation und waehlt aus den
 * gespeicherten Zeilen den passenden Kurs zum Stichtag (`pickRate`).
 */
import { dbInternal } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { FxRateSource } from "@/schemas/fx";
import { pickRate, type FxPick, type FxRow } from "./pick-rate";

const rowSource = (s: string): FxRow["source"] | null => (s === "ECB" || s === "MONTHLY" ? s : null);

/**
 * Fenster: ab dem 1. des Vormonats des Stichtags (die Monatskurswahl greift auf den Vormonat
 * zurueck; ein Fenster von 40 Tagen reichte dafuer ab dem 29. eines Monats nicht aus) bis Stichtag.
 */
export async function rateFor(
  orgId: string,
  currency: string,
  stichtag: Date,
  db: typeof dbInternal | Prisma.TransactionClient = dbInternal,
): Promise<FxPick | null> {
  const settings = await db.documentSettings.findUnique({ where: { orgId }, select: { fxRateSource: true } });
  const mode = FxRateSource.catch("BMF_MONTHLY").parse(settings?.fxRateSource ?? "BMF_MONTHLY");
  const windowStart = new Date(Date.UTC(stichtag.getUTCFullYear(), stichtag.getUTCMonth() - 1, 1));
  const stored = await db.exchangeRate.findMany({
    where: { currency, rateDate: { gte: windowStart, lte: stichtag } },
    select: { source: true, currency: true, rateDate: true, rateMicros: true },
  });
  const rows: FxRow[] = [];
  for (const r of stored) {
    const source = rowSource(r.source);
    if (source) rows.push({ source, currency: r.currency, rateDate: r.rateDate, rateMicros: r.rateMicros });
  }
  return pickRate(rows, currency, stichtag, mode);
}
