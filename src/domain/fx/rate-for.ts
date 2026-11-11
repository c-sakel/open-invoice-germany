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
 * Liegt der Stichtag nach `now` (Vorausrechnung), gilt der juengste Kurs bis `now` (siehe `pickRate`).
 */
export async function rateFor(
  orgId: string,
  currency: string,
  stichtag: Date,
  db: typeof dbInternal | Prisma.TransactionClient = dbInternal,
  now: Date = new Date(),
): Promise<FxPick | null> {
  const settings = await db.documentSettings.findUnique({ where: { orgId }, select: { fxRateSource: true } });
  const mode = FxRateSource.catch("BMF_MONTHLY").parse(settings?.fxRateSource ?? "BMF_MONTHLY");
  const futureMonth =
    mode === "BMF_MONTHLY" && stichtag.getUTCFullYear() * 12 + stichtag.getUTCMonth() > now.getUTCFullYear() * 12 + now.getUTCMonth();
  const effective = stichtag.getTime() > now.getTime() ? now : stichtag;
  const windowStart = new Date(Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth() - 1, 1));
  const stored = await db.exchangeRate.findMany({
    where: futureMonth
      ? { currency, source: "MONTHLY", rateDate: { lte: now } }
      : { currency, rateDate: { gte: windowStart, lte: effective } },
    select: { source: true, currency: true, rateDate: true, rateMicros: true },
  });
  const rows: FxRow[] = [];
  for (const r of stored) {
    const source = rowSource(r.source);
    if (source) rows.push({ source, currency: r.currency, rateDate: r.rateDate, rateMicros: r.rateMicros });
  }
  return pickRate(rows, currency, stichtag, mode, now);
}
