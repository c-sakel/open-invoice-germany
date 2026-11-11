/**
 * Zahlungseingang je Kalendermonat (Phase 16f, Task 5). Rein lesend, org-gescoped (ueber
 * `invoice.orgId`, Payment selbst traegt keine orgId), Aggregation in JS (DB-portabel,
 * Monatsgrenzen UTC wie `monthlyRevenue`).
 *
 * `paidCents` = Summe der `Payment.amountCents` nach `paidAt`: Zahlungen positiv,
 * Gegenbuchungen (`kind REVERSAL`) negativ im Monat der Gegenbuchung. Skonto-Zahlungen
 * (`method SKONTO` / `isSkonto`) und Verrechnungen mit Gutschriften (`method CREDIT_NOTE`)
 * sind kein Geldeingang; Gegenbuchungen erben Methode/Flag der Originalzahlung und fallen
 * damit automatisch ebenfalls heraus. Waehrungen werden nie gemischt: je Waehrung eine
 * eigene Reihe, nur Waehrungen mit mindestens einem Wert.
 */
import { dbInternal } from "@/lib/db";
import { monthKey } from "./revenue";

export interface CashInPoint {
  month: string; // "YYYY-MM" (UTC)
  currency: string;
  paidCents: number;
  invoicedGrossCents: number;
}

export interface CashInOptions {
  months?: number;
  now?: Date;
}

export async function monthlyCashIn(orgId: string, opts: CashInOptions = {}): Promise<CashInPoint[]> {
  const months = opts.months ?? 12;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const [payments, invoices] = await Promise.all([
    dbInternal.payment.findMany({
      where: {
        invoice: { orgId },
        paidAt: { gte: start, lt: end },
        isSkonto: false,
        method: { notIn: ["CREDIT_NOTE", "SKONTO"] },
      },
      select: { amountCents: true, paidAt: true, invoice: { select: { currency: true } } },
    }),
    dbInternal.invoice.findMany({
      where: { orgId, status: { not: "DRAFT" }, issueDate: { gte: start, lt: end } },
      select: { issueDate: true, currency: true, type: true, grossTotalCents: true, payableCents: true },
    }),
  ]);

  const monthKeys: string[] = [];
  for (let i = 0; i < months; i++) monthKeys.push(monthKey(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))));

  const byCurrency = new Map<string, Map<string, CashInPoint>>();
  const bucket = (currency: string, month: string): CashInPoint | undefined => {
    let series = byCurrency.get(currency);
    if (!series) {
      series = new Map(monthKeys.map((m) => [m, { month: m, currency, paidCents: 0, invoicedGrossCents: 0 }]));
      byCurrency.set(currency, series);
    }
    return series.get(month);
  };

  for (const p of payments) {
    const b = bucket(p.invoice.currency, monthKey(p.paidAt));
    if (b) b.paidCents += p.amountCents;
  }
  for (const inv of invoices) {
    const b = bucket(inv.currency, monthKey(inv.issueDate));
    if (!b) continue;
    const gross = inv.payableCents ?? inv.grossTotalCents;
    b.invoicedGrossCents += inv.type === "CREDIT_NOTE" ? -Math.abs(gross) : gross;
  }

  return [...byCurrency.keys()].sort().flatMap((c) => [...(byCurrency.get(c)?.values() ?? [])]);
}
