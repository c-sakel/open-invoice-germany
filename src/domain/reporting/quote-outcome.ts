/**
 * Angebotsquote (Phase 16f, Task 5): Angebote (`kind ANGEBOT`) im Zeitfenster nach
 * `issueDate`, je Waehrung nach Ausgang gezaehlt. DRAFT/CANCELLED zaehlen nicht. `expired` =
 * Status EXPIRED oder SENT mit `validUntil` vor heute (UTC) — der Status wird nicht ueberall
 * zeitnah umgestellt. `acceptedPermille` = angenommen / entschieden (angenommen + abgelehnt +
 * abgelaufen), half-up; `null` ohne entschiedene Angebote.
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";

export interface QuoteBucket {
  count: number;
  netCents: number;
}

export interface QuoteOutcomeRow {
  currency: string;
  accepted: QuoteBucket;
  rejected: QuoteBucket;
  expired: QuoteBucket;
  open: QuoteBucket;
  acceptedPermille: number | null;
}

export interface QuoteOutcomeOptions {
  months?: number;
  now?: Date;
}

export async function quoteOutcome(orgId: string, opts: QuoteOutcomeOptions = {}): Promise<QuoteOutcomeRow[]> {
  const months = opts.months ?? 12;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const quotes = await dbInternal.quote.findMany({
    where: { orgId, kind: "ANGEBOT", status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: start, lt: end } },
    select: { status: true, validUntil: true, currency: true, netTotalCents: true },
  });

  const rows = new Map<string, QuoteOutcomeRow>();
  for (const q of quotes) {
    let row = rows.get(q.currency);
    if (!row) {
      row = {
        currency: q.currency,
        accepted: { count: 0, netCents: 0 },
        rejected: { count: 0, netCents: 0 },
        expired: { count: 0, netCents: 0 },
        open: { count: 0, netCents: 0 },
        acceptedPermille: null,
      };
      rows.set(q.currency, row);
    }
    const lapsed = q.status === "SENT" && q.validUntil !== null && q.validUntil < today;
    const target =
      q.status === "ACCEPTED" ? row.accepted
      : q.status === "REJECTED" ? row.rejected
      : q.status === "EXPIRED" || lapsed ? row.expired
      : row.open;
    target.count += 1;
    target.netCents += q.netTotalCents;
  }

  for (const row of rows.values()) {
    const decided = row.accepted.count + row.rejected.count + row.expired.count;
    row.acceptedPermille = decided === 0 ? null : roundHalfUp((row.accepted.count * 1000) / decided);
  }
  return [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
