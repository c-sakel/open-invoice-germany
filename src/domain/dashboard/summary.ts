/**
 * Dashboard-Kennzahlen (Phase 8b, Task 4, `/` fuer angemeldete Nutzer). Rein lesend,
 * org-scoped, DB-portabel (Aggregation in JS ueber select-reduzierte Zeilen statt
 * DB-spezifischer Funktionen — Global Constraint).
 */
import { dbInternal } from "@/lib/db";
import { effectiveInvoiceStatus } from "@/domain/invoice/status";
import { openAmountCents } from "@/domain/invoice/amounts";
import { effectiveQuoteStatus } from "@/domain/document/status";

export interface AgingBucket {
  count: number;
  cents: number;
}

export interface AgingBuckets {
  d1_7: AgingBucket;
  d8_30: AgingBucket;
  d31_60: AgingBucket;
  d60plus: AgingBucket;
}

function emptyBucket(): AgingBucket {
  return { count: 0, cents: 0 };
}

/**
 * Aging-Helfer, gemeinsam mit `src/domain/dunning/overview.ts` genutzt (Task-4-Brief):
 * verteilt ueberfaellige Zeilen (Faelligkeitsdatum + offener Betrag) auf vier Buckets.
 * `bounds` = obere Tagesgrenzen der ersten drei Buckets (Default 7/30/60, wie bisher
 * hartkodiert in der Mahnuebersicht) — der vierte Bucket faengt alles darueber.
 * Zeilen mit `daysOverdue < 1` (heute faellig, noch nicht wirklich ueberfaellig) zaehlen
 * NICHT in die Buckets (unveraendertes Verhalten aus der Mahnuebersicht).
 */
export function agingBuckets(
  rows: { dueDate: Date; cents: number }[],
  now: Date = new Date(),
  bounds: [number, number, number] = [7, 30, 60],
): AgingBuckets {
  const aging: AgingBuckets = { d1_7: emptyBucket(), d8_30: emptyBucket(), d31_60: emptyBucket(), d60plus: emptyBucket() };
  for (const row of rows) {
    const daysOverdue = Math.floor((now.getTime() - row.dueDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysOverdue < 1) continue;
    const bucket = daysOverdue <= bounds[0] ? aging.d1_7 : daysOverdue <= bounds[1] ? aging.d8_30 : daysOverdue <= bounds[2] ? aging.d31_60 : aging.d60plus;
    bucket.count += 1;
    bucket.cents += row.cents;
  }
  return aging;
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
  revenueThisMonthCents: number;
  aging: AgingBuckets;
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
  const overdueRows: { dueDate: Date; cents: number }[] = [];

  for (const inv of openish) {
    const status = effectiveInvoiceStatus({ status: inv.status, dueDate: inv.dueDate, issueDate: inv.issueDate }, now);
    const open = openAmountCents(inv);
    if (status === "OPEN") {
      openInvoices.count += 1;
      openInvoices.cents += open;
    } else if (status === "DUE") {
      dueInvoices.count += 1;
      dueInvoices.cents += open;
    } else if (status === "OVERDUE") {
      overdueInvoices.count += 1;
      overdueInvoices.cents += open;
      overdueRows.push({ dueDate: inv.dueDate ?? inv.issueDate, cents: open });
    }
  }

  const aging = agingBuckets(overdueRows, now);

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
    revenueThisMonthCents: revenueAgg._sum.grossTotalCents ?? 0,
    aging,
    recentDocuments,
    openQuotes,
  };
}
