/**
 * Wechselkurs-Speicher (instanzweit, nicht je Organisation): Tageskurse der EZB, daraus
 * berechnete Monatsmittel und manuell gepflegte Kurse (z. B. amtliche BMF-Monatswerte).
 * Konvention: Monatszeile (`source = "MONTHLY"`) ist auf den 1. des Monats (UTC) datiert.
 * Gepflegte Werte (`origin = "MANUAL"`) werden von keinem Import/keiner Berechnung ueberschrieben.
 */
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import type { exchangeRateUpsertSchema } from "@/schemas/fx";
import type { z } from "zod";
import { assertSupportedRate } from "./decimal";
import { ECB_DAILY_URL, ECB_HIST90_URL, fetchEcbXml, parseEcbXmlDetailed } from "./fetch-ecb";
import { monthlyAverageMicros } from "./monthly-average";
import type { FxRow } from "./pick-rate";

const DAY_MS = 86_400_000;

export interface ExchangeRateRow {
  id: string;
  source: string;
  currency: string;
  rateDate: Date;
  rateMicros: number;
  origin: string;
  note: string | null;
  fetchedAt: Date;
}

const rateSelect = { id: true, source: true, currency: true, rateDate: true, rateMicros: true, origin: true, note: true, fetchedAt: true } as const;

const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const prevMonthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));

/** Legt fehlende Tageskurse an (bestehende Zeilen, auch gepflegte, bleiben unveraendert). */
export async function storeDailyRates(rows: FxRow[], now: Date): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };
  for (const r of rows) assertSupportedRate(r.rateMicros);
  const dates = [...new Set(rows.map((r) => r.rateDate.getTime()))].map((t) => new Date(t));
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const existing = await dbInternal.exchangeRate.findMany({
    where: { source: { in: [...new Set(rows.map((r) => r.source))] }, rateDate: { in: dates }, currency: { in: currencies } },
    select: { source: true, currency: true, rateDate: true },
  });
  const key = (source: string, currency: string, d: Date): string => `${source}|${currency}|${d.getTime()}`;
  const known = new Set(existing.map((e) => key(e.source, e.currency, e.rateDate)));
  let inserted = 0;
  for (const r of rows) {
    if (known.has(key(r.source, r.currency, r.rateDate))) continue;
    known.add(key(r.source, r.currency, r.rateDate));
    await dbInternal.exchangeRate.upsert({
      where: { source_currency_rateDate: { source: r.source, currency: r.currency, rateDate: r.rateDate } },
      create: { source: r.source, currency: r.currency, rateDate: r.rateDate, rateMicros: r.rateMicros, origin: "IMPORTED", fetchedAt: now },
      update: {},
      select: { id: true },
    });
    inserted += 1;
  }
  return { inserted };
}

/**
 * Monatsmittel je Waehrung aus den vorhandenen EZB-Tageskursen des Monats (nur tatsaechlich
 * vorhandene Tage, keine Luecken-/Nullwerte). Nur fuer abgeschlossene Monate; vorhandene
 * gepflegte oder importierte Monatswerte bleiben unberuehrt.
 */
export async function computeMonthlyAverages(month: Date, now: Date): Promise<{ written: number }> {
  const start = monthStart(month);
  const end = nextMonthStart(month);
  if (end.getTime() > now.getTime()) return { written: 0 };
  const daily = await dbInternal.exchangeRate.findMany({
    where: { source: "ECB", rateDate: { gte: start, lt: end } },
    select: { currency: true, rateMicros: true },
  });
  const byCurrency = new Map<string, number[]>();
  for (const d of daily) {
    const list = byCurrency.get(d.currency) ?? [];
    list.push(d.rateMicros);
    byCurrency.set(d.currency, list);
  }
  let written = 0;
  for (const [currency, values] of byCurrency) {
    const avg = monthlyAverageMicros(values);
    const where = { source_currency_rateDate: { source: "MONTHLY", currency, rateDate: start } };
    const current = await dbInternal.exchangeRate.findUnique({ where, select: { origin: true, rateMicros: true } });
    if (current && current.origin !== "COMPUTED") continue;
    if (current && current.rateMicros === avg) continue;
    const note = `Mittel aus ${values.length} EZB-Tageskursen`;
    await dbInternal.exchangeRate.upsert({
      where,
      create: { source: "MONTHLY", currency, rateDate: start, rateMicros: avg, origin: "COMPUTED", note, fetchedAt: now },
      update: { rateMicros: avg, note, fetchedAt: now },
      select: { id: true },
    });
    written += 1;
  }
  return { written };
}

/** Anzahl Werktage (Mo-Fr) im Intervall (von, bis], jeweils als UTC-Kalendertage. */
function weekdaysBetween(from: Date, to: Date): number {
  const f = Math.floor(from.getTime() / DAY_MS);
  const t = Math.floor(to.getTime() / DAY_MS);
  let n = 0;
  for (let d = f + 1; d <= t; d += 1) {
    const wd = new Date(d * DAY_MS).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

export interface RefreshResult {
  inserted: number;
  /** Anzahl Monate, fuer die ein Monatsmittel neu geschrieben wurde. */
  months: number;
  /** Nicht abbildbare Kurse (z. B. IDR), je Waehrung einmal. */
  skippedCurrencies: string[];
}

/**
 * Tageskurse abrufen und speichern; klafft eine Luecke (juengster gespeicherter Kurs mehr als
 * 1 Werktag alt), zusaetzlich die 90-Tage-Datei. Danach Monatsmittel fuer den Vormonat.
 * Netz-/Formatfehler werden geworfen (der Scheduler-Job faengt sie ab).
 */
export async function refreshExchangeRates(now: Date, fetchImpl?: typeof fetch): Promise<RefreshResult> {
  const latest = await dbInternal.exchangeRate.findFirst({
    where: { source: "ECB" },
    orderBy: { rateDate: "desc" },
    select: { rateDate: true },
  });
  const gap = !latest || weekdaysBetween(latest.rateDate, now) > 1;

  const skipped = new Set<string>();
  let inserted = 0;
  const urls = gap ? [ECB_HIST90_URL, ECB_DAILY_URL] : [ECB_DAILY_URL];
  for (const url of urls) {
    const parsed = parseEcbXmlDetailed(await fetchEcbXml(url, fetchImpl));
    for (const s of parsed.skipped) skipped.add(s.currency);
    inserted += (await storeDailyRates(parsed.rows, now)).inserted;
  }

  const averages = await computeMonthlyAverages(prevMonthStart(now), now);
  return { inserted, months: averages.written > 0 ? 1 : 0, skippedCurrencies: [...skipped].sort() };
}

/** Pflegt einen Kurs manuell (z. B. amtlicher BMF-Monatswert); ueberschreibt Importe und Berechnungen. */
export async function upsertManualRate(
  input: z.infer<typeof exchangeRateUpsertSchema>,
  actor: string,
  orgId?: string,
): Promise<ExchangeRateRow> {
  const data = input; // bereits durch exchangeRateUpsertSchema geparst (Boundary: Route/MCP/Action)
  assertSupportedRate(data.rate);
  const now = new Date();
  const note = data.note ?? null;
  const where = { source_currency_rateDate: { source: data.source, currency: data.currency, rateDate: data.rateDate } };
  const row = await dbInternal.exchangeRate.upsert({
    where,
    create: { source: data.source, currency: data.currency, rateDate: data.rateDate, rateMicros: data.rate, origin: "MANUAL", note, fetchedAt: now },
    update: { rateMicros: data.rate, origin: "MANUAL", note, fetchedAt: now },
    select: rateSelect,
  });
  const logOrgId = orgId ?? (await dbInternal.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  if (logOrgId) {
    await logActivity(dbInternal, {
      orgId: logOrgId,
      entityType: "EXCHANGE_RATE",
      entityId: row.id,
      type: "FX_RATE_SET",
      actor,
      at: now,
      data: { source: data.source, currency: data.currency, rateDate: data.rateDate.toISOString().slice(0, 10), rateMicros: data.rate },
    });
  }
  return row;
}
