/**
 * Dashboard-Kennzahlen (Phase 8b, Task 4, `/` fuer angemeldete Nutzer). Rein lesend,
 * org-scoped, DB-portabel (Aggregation in JS ueber select-reduzierte Zeilen statt
 * DB-spezifischer Funktionen — Global Constraint).
 *
 * Fix-Runde 1 (Koordinator, §45): drei zusaetzliche Kennzahlen (dueThisWeek/
 * partiallyPaid/dunningRequired) sowie ein verallgemeinerter `agingBuckets`-Helfer
 * (N+1 Buckets statt fix vier), damit das Dashboard 5 Buckets (Grenzen 7/30/60/90,
 * Tag 0 eingeschlossen) zeigen kann, waehrend die Mahnuebersicht weiterhin ihre
 * bisherigen 4 Buckets (Grenzen 7/30/60, `daysOverdue >= 1`, §25) unveraendert liefert.
 */
import { dbInternal } from "@/lib/db";
import { effectiveInvoiceStatus } from "@/domain/invoice/status";
import { openAmountCents } from "@/domain/invoice/amounts";
import { effectiveQuoteStatus } from "@/domain/document/status";
import { dunningCandidates } from "@/domain/dunning/auto";

export interface AgingBucket {
  /** Deutsches Anzeigelabel, aus `bounds`/`minDays` abgeleitet (z. B. "8–30 Tage"). */
  label: string;
  count: number;
  cents: number;
}

/** Beginn des Kalendertags (lokale Zeit) von `d` — analog invoice/status.ts. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export interface AgingBucketsOptions {
  /** Kleinste Tagesanzahl, die noch in einen Bucket faellt (Default 1 — "faellig heute",
   *  daysOverdue===0, zaehlt NICHT mit, §25). Das Dashboard uebergibt 0, um den heutigen
   *  Faelligkeitstag mit in den ersten Bucket aufzunehmen (§45). */
  minDays?: number;
}

/**
 * Verallgemeinerter Aging-Helfer (Fix-Runde 1, Koordinator): verteilt ueberfaellige
 * Zeilen (Faelligkeitsdatum + Betrag) auf `bounds.length + 1` Buckets — je Eintrag in
 * `bounds` ein Bucket mit oberer Tagesgrenze, plus ein abschliessender "> letzte Grenze"-
 * Bucket. `bounds` MUSS aufsteigend sortiert sein (z. B. `[7, 30, 60]` fuer die
 * Mahnuebersicht oder `[7, 30, 60, 90]` fuer das Dashboard). Labels werden aus den
 * Grenzen + `minDays` abgeleitet, keine hartkodierten Bucket-Schluessel mehr (ersetzt die
 * vorherige feste Vier-Schluessel-Form `{d1_7, d8_30, d31_60, d60plus}` — Aufrufer, die
 * diese Form nach aussen weiterreichen (z. B. `loadDunningOverview`), bauen sie lokal aus
 * dem Array wieder auf).
 */
export function agingBuckets(
  rows: { dueDate: Date; cents: number }[],
  now: Date = new Date(),
  bounds: number[] = [7, 30, 60],
  opts: AgingBucketsOptions = {},
): AgingBucket[] {
  const minDays = opts.minDays ?? 1;
  const buckets: AgingBucket[] = bounds.map((bound, i) => ({
    label: i === 0 ? `${minDays}–${bound} Tage` : `${bounds[i - 1] + 1}–${bound} Tage`,
    count: 0,
    cents: 0,
  }));
  buckets.push({ label: `> ${bounds[bounds.length - 1]} Tage`, count: 0, cents: 0 });

  const today = startOfDay(now);
  for (const row of rows) {
    const daysOverdue = Math.round((today.getTime() - startOfDay(row.dueDate).getTime()) / (1000 * 60 * 60 * 24));
    if (daysOverdue < minDays) continue;
    let idx = bounds.findIndex((bound) => daysOverdue <= bound);
    if (idx === -1) idx = buckets.length - 1;
    buckets[idx].count += 1;
    buckets[idx].cents += row.cents;
  }
  return buckets;
}

export interface DashboardRecentDocument {
  kind: "INVOICE" | "QUOTE" | "DELIVERY_NOTE";
  id: string;
  number: string | null;
  customerName: string;
  date: Date;
  grossCents: number | null;
  status: string;
}

export interface DashboardSummary {
  openInvoices: { count: number; cents: number };
  dueInvoices: { count: number; cents: number };
  overdueInvoices: { count: number; cents: number };
  /** Fix-Runde 1 (§45): Rechnungen mit Faelligkeit in den naechsten 7 Tagen (heute
   *  eingeschlossen), unabhaengig vom effektiven Status — nur PAID/CANCELLED sind
   *  ausgenommen (Vorgabe: "nicht PAID/CANCELLED"). */
  dueThisWeek: { count: number; cents: number };
  /** Fix-Runde 1 (§45): Rechnungen mit Status PARTIALLY_PAID. */
  partiallyPaid: { count: number; cents: number };
  /** Fix-Runde 1 (§45): Anzahl mahnbarer, bereits faelliger Rechnungen — dieselbe
   *  Auswahl wie der automatische Mahnlauf (`dunningCandidates`, dunning/auto.ts). */
  dunningRequired: { count: number };
  revenueThisMonthCents: number;
  aging: AgingBucket[];
  recentDocuments: DashboardRecentDocument[];
  openQuotes: { count: number; cents: number };
}

/** Beginn des Kalendermonats (lokale Zeit) von `d`. */
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

export async function dashboardSummary(orgId: string, now: Date = new Date()): Promise<DashboardSummary> {
  // Offene/faellige/ueberfaellige Rechnungen — nur FINALIZED/SENT/PARTIALLY_PAID koennen
  // effectiveInvoiceStatus OPEN/DUE/OVERDUE liefern (siehe status.ts).
  const openish = await dbInternal.invoice.findMany({
    where: { orgId, status: { in: ["FINALIZED", "SENT", "PARTIALLY_PAID"] } },
    select: { id: true, status: true, dueDate: true, issueDate: true, grossTotalCents: true, paidAmountCents: true, payableCents: true },
  });

  const openInvoices = { count: 0, cents: 0 };
  const dueInvoices = { count: 0, cents: 0 };
  const overdueInvoices = { count: 0, cents: 0 };
  const partiallyPaid = { count: 0, cents: 0 };
  // Aging (§45, Dashboard): Tag 0 ("faellig heute") zaehlt mit, deshalb DUE- UND
  // OVERDUE-Zeilen sammeln (nicht nur OVERDUE wie bei der Mahnuebersicht).
  const agingRows: { dueDate: Date; cents: number }[] = [];

  for (const inv of openish) {
    const status = effectiveInvoiceStatus({ status: inv.status, dueDate: inv.dueDate, issueDate: inv.issueDate }, now);
    const open = openAmountCents(inv);
    if (status === "OPEN") {
      openInvoices.count += 1;
      openInvoices.cents += open;
    } else if (status === "DUE") {
      dueInvoices.count += 1;
      dueInvoices.cents += open;
      agingRows.push({ dueDate: inv.dueDate ?? inv.issueDate, cents: open });
    } else if (status === "OVERDUE") {
      overdueInvoices.count += 1;
      overdueInvoices.cents += open;
      agingRows.push({ dueDate: inv.dueDate ?? inv.issueDate, cents: open });
    }
    if (inv.status === "PARTIALLY_PAID") {
      partiallyPaid.count += 1;
      partiallyPaid.cents += open;
    }
  }

  // Dashboard-Aging: Grenzen 7/30/60/90 (5 Buckets), Tag 0 eingeschlossen (minDays: 0) —
  // abweichend von der Mahnuebersicht (7/30/60, minDays: 1, §25).
  const aging = agingBuckets(agingRows, now, [7, 30, 60, 90], { minDays: 0 });

  // Faellig in den naechsten 7 Tagen (heute eingeschlossen), unabhaengig vom effektiven
  // Status — nur PAID/CANCELLED ausgenommen (§45). Eigene Query (breiter als `openish`,
  // schliesst z. B. DRAFT mit gesetztem Zahlungsziel ein).
  const today = startOfDay(now);
  const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 8); // exklusiv: +7 Tage inklusive
  const dueThisWeekRows = await dbInternal.invoice.findMany({
    where: { orgId, status: { notIn: ["PAID", "CANCELLED"] }, dueDate: { gte: today, lt: weekEnd } },
    select: { grossTotalCents: true, paidAmountCents: true, payableCents: true },
  });
  const dueThisWeek = { count: dueThisWeekRows.length, cents: dueThisWeekRows.reduce((sum, r) => sum + openAmountCents(r), 0) };

  // Mahnbare, bereits faellige Rechnungen — dieselbe Auswahl wie der automatische
  // Mahnlauf (dunning/auto.ts), keine eigene Query (CLAUDE.md "Nichts doppelt bauen").
  const dunningRequired = { count: (await dunningCandidates(orgId, now)).length };

  // Umsatz laufender Monat: Bruttosumme festgeschriebener Rechnungen (nicht DRAFT,
  // nicht CANCELLED) mit issueDate im aktuellen Kalendermonat. Prisma-Aggregat (portabel).
  const revenueAgg = await dbInternal.invoice.aggregate({
    where: {
      orgId,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: startOfMonth(now), lt: startOfNextMonth(now) },
    },
    _sum: { grossTotalCents: true },
  });

  // Offene Angebote: DRAFT/SENT und (falls gesetzt) noch nicht abgelaufen.
  const quotes = await dbInternal.quote.findMany({
    where: { orgId, status: { in: ["DRAFT", "SENT"] } },
    select: { status: true, validUntil: true, grossTotalCents: true },
  });
  const openQuotes = { count: 0, cents: 0 };
  for (const q of quotes) {
    const status = effectiveQuoteStatus({ status: q.status, validUntil: q.validUntil }, now);
    if (status === "DRAFT" || status === "SENT") {
      openQuotes.count += 1;
      openQuotes.cents += q.grossTotalCents;
    }
  }

  // Letzte 5 Belege (Rechnung/Angebot/Lieferschein) ueber alle drei Tabellen, gemischt
  // nach Datum sortiert — je Tabelle die letzten 5 laden (billig) und danach in JS
  // mischen/kuerzen, statt einer DB-spezifischen UNION-Query (Global Constraint).
  const [recentInvoices, recentQuotes, recentDeliveryNotes] = await Promise.all([
    dbInternal.invoice.findMany({
      where: { orgId },
      orderBy: { issueDate: "desc" },
      take: 5,
      select: { id: true, number: true, status: true, issueDate: true, grossTotalCents: true, customer: { select: { name: true } } },
    }),
    dbInternal.quote.findMany({
      where: { orgId },
      orderBy: { issueDate: "desc" },
      take: 5,
      select: { id: true, number: true, status: true, issueDate: true, grossTotalCents: true, customer: { select: { name: true } } },
    }),
    dbInternal.deliveryNote.findMany({
      where: { orgId },
      orderBy: { issueDate: "desc" },
      take: 5,
      select: { id: true, number: true, status: true, issueDate: true, customer: { select: { name: true } } },
    }),
  ]);

  const recentDocuments: DashboardRecentDocument[] = [
    ...recentInvoices.map((r) => ({
      kind: "INVOICE" as const,
      id: r.id,
      number: r.number,
      customerName: r.customer.name,
      date: r.issueDate,
      grossCents: r.grossTotalCents,
      status: r.status,
    })),
    ...recentQuotes.map((r) => ({
      kind: "QUOTE" as const,
      id: r.id,
      number: r.number,
      customerName: r.customer.name,
      date: r.issueDate,
      grossCents: r.grossTotalCents,
      status: r.status,
    })),
    ...recentDeliveryNotes.map((r) => ({
      kind: "DELIVERY_NOTE" as const,
      id: r.id,
      number: r.number,
      customerName: r.customer.name,
      date: r.issueDate,
      grossCents: null,
      status: r.status,
    })),
  ]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 5);

  return {
    openInvoices,
    dueInvoices,
    overdueInvoices,
    dueThisWeek,
    partiallyPaid,
    dunningRequired,
    revenueThisMonthCents: revenueAgg._sum.grossTotalCents ?? 0,
    aging,
    recentDocuments,
    openQuotes,
  };
}
