/**
 * Top-Kunden nach Netto-Umsatz (Phase 12e). Rein lesend, org-gescoped, DB-portabel —
 * dieselbe Begruendung wie src/domain/reporting/revenue.ts (`select`-reduzierte Zeilen +
 * Aggregation in JS statt DB-spezifischer Funktionen). Nutzt `netShareCents` aus
 * revenue.ts fuer die Netto-Bemessungsgrundlage (Abschlagsketten-Ruling) und dreht das
 * Vorzeichen bei `type: CREDIT_NOTE` wie `monthlyRevenue` — kein zweites, eigenes
 * Vorzeichen-/Anteilsverfahren.
 */
import { dbInternal } from "@/lib/db";
import { netShareCents } from "./revenue";

export interface TopCustomer {
  customerId: string;
  name: string;
  netCents: number;
  invoiceCount: number;
}

export interface TopCustomersOptions {
  months?: number;
  limit?: number;
  now?: Date;
}

/**
 * Die `limit` (Default 5) umsatzstaerksten Kunden der letzten `months` Kalendermonate
 * (Default 12, gleiches Fenster wie `monthlyRevenue`), absteigend nach Netto-Umsatz
 * sortiert. Nur festgeschriebene Belege (`status` weder DRAFT noch CANCELLED).
 */
export async function topCustomers(orgId: string, opts: TopCustomersOptions = {}): Promise<TopCustomer[]> {
  const months = opts.months ?? 12;
  const limit = opts.limit ?? 5;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const rows = await dbInternal.invoice.findMany({
    where: {
      orgId,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: start, lt: end },
    },
    select: {
      customerId: true,
      type: true,
      netTotalCents: true,
      grossTotalCents: true,
      payableCents: true,
      customer: { select: { name: true } },
    },
  });

  const buckets = new Map<string, TopCustomer>();
  for (const r of rows) {
    const existing = buckets.get(r.customerId) ?? { customerId: r.customerId, name: r.customer.name, netCents: 0, invoiceCount: 0 };
    const sign = r.type === "CREDIT_NOTE" ? -1 : 1;
    existing.netCents += sign * netShareCents(r);
    existing.invoiceCount += 1;
    buckets.set(r.customerId, existing);
  }

  return [...buckets.values()].sort((a, b) => b.netCents - a.netCents).slice(0, limit);
}
