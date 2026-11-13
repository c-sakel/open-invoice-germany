/**
 * Phase 16d — Auswertung und Protokollansicht des Postversands (Oberflaeche).
 *
 * Monatssummen je Berliner Kalendermonat: Summe `priceCents ?? quotedPriceCents` nur fuer LIVE-Auftraege
 * ohne FAILED/CANCELLED (== Budgetrechnung in send.ts). TEST- und Trockenlaeufe werden getrennt gezaehlt,
 * nie als Kosten.
 */
import { dbInternal } from "@/lib/db";
import { berlinMonthKey, berlinMonthStart } from "@/lib/berlin-time";

export interface PostalMonthTotal {
  /** "YYYY-MM" (Berliner Monat). */
  month: string;
  liveCount: number;
  liveCents: number;
  testCount: number;
  dryRunCount: number;
}

interface MonthRow {
  mode: string;
  status: string;
  priceCents: number | null;
  quotedPriceCents: number | null;
  createdAt: Date;
}

const NOT_COUNTED = ["FAILED", "CANCELLED"];

/** Rein: gruppiert Auftraege nach Berliner Monat, juengster Monat zuerst. */
export function aggregatePostalMonths(rows: MonthRow[]): PostalMonthTotal[] {
  const byMonth = new Map<string, PostalMonthTotal>();
  for (const r of rows) {
    if (NOT_COUNTED.includes(r.status)) continue;
    const month = berlinMonthKey(r.createdAt);
    let m = byMonth.get(month);
    if (!m) {
      m = { month, liveCount: 0, liveCents: 0, testCount: 0, dryRunCount: 0 };
      byMonth.set(month, m);
    }
    if (r.mode === "LIVE") {
      m.liveCount += 1;
      m.liveCents += r.priceCents ?? r.quotedPriceCents ?? 0;
    } else if (r.mode === "TEST") {
      m.testCount += 1;
    } else {
      m.dryRunCount += 1;
    }
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

export async function postalMonthTotals(orgId: string, opts: { months: number; now?: Date }): Promise<PostalMonthTotal[]> {
  const now = opts.now ?? new Date();
  const since = berlinMonthStart(now, -(Math.max(1, opts.months) - 1));
  const rows = await dbInternal.postalJob.findMany({
    where: { orgId, createdAt: { gte: since } },
    select: { mode: true, status: true, priceCents: true, quotedPriceCents: true, createdAt: true },
  });
  return aggregatePostalMonths(rows);
}

export interface PostalProtocolRow {
  id: string;
  createdAt: string;
  submittedAt: string | null;
  docType: "INVOICE" | "DUNNING";
  docId: string;
  invoiceId: string;
  docNumber: string;
  mode: "DRY_RUN" | "TEST" | "LIVE";
  status: string;
  pages: number;
  registered: string | null;
  priceCents: number | null;
  quotedPriceCents: number | null;
  trackingCode: string | null;
  trackingStatus: string | null;
  pdfSha256: string;
  error: string | null;
  events: { id: string; at: string; kind: string; status: string }[];
}

function asDocType(v: string): "INVOICE" | "DUNNING" {
  return v === "DUNNING" ? "DUNNING" : "INVOICE";
}
function asMode(v: string): "DRY_RUN" | "TEST" | "LIVE" {
  return v === "LIVE" || v === "TEST" ? v : "DRY_RUN";
}

/** Protokollzeilen (juengste zuerst) mit Ereignissen; optional nur eines Belegs (Rechnung samt ihrer Mahnungen). */
export async function listPostalProtocol(orgId: string, opts: { invoiceId?: string; limit?: number } = {}): Promise<PostalProtocolRow[]> {
  const rows = await dbInternal.postalJob.findMany({
    where: { orgId, ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
    select: {
      id: true,
      createdAt: true,
      submittedAt: true,
      docType: true,
      docId: true,
      invoiceId: true,
      docNumber: true,
      mode: true,
      status: true,
      pages: true,
      registered: true,
      priceCents: true,
      quotedPriceCents: true,
      trackingCode: true,
      trackingStatus: true,
      pdfSha256: true,
      error: true,
      events: { orderBy: [{ at: "asc" }, { id: "asc" }], select: { id: true, at: true, kind: true, status: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    docType: asDocType(r.docType),
    docId: r.docId,
    invoiceId: r.invoiceId,
    docNumber: r.docNumber,
    mode: asMode(r.mode),
    status: r.status,
    pages: r.pages,
    registered: r.registered,
    priceCents: r.priceCents,
    quotedPriceCents: r.quotedPriceCents,
    trackingCode: r.trackingCode,
    trackingStatus: r.trackingStatus,
    pdfSha256: r.pdfSha256,
    error: r.error,
    events: r.events.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, status: e.status })),
  }));
}
