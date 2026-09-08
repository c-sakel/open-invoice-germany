/**
 * Top-Kunden nach Netto-Umsatz (Phase 12e). Rein lesend, org-gescoped, DB-portabel —
 * dieselbe Begruendung wie src/domain/reporting/revenue.ts (`select`-reduzierte Zeilen +
 * Aggregation in JS statt DB-spezifischer Funktionen). Nutzt `netShareCents` aus
 * revenue.ts fuer die Netto-Bemessungsgrundlage (Abschlagsketten-Ruling).
 *
 * KEIN manuelles Vorzeichen nach `type` und KEIN Ausschluss von `status: CANCELLED` — aus
 * denselben Gruenden wie in revenue.ts (siehe dortiger Modulkommentar, Fix 1): Gutschriften/
 * Stornos tragen bereits negative Betraege, ein Original bleibt nach Stornierung mit vollem
 * Betrag in seinem eigenen Monat gezaehlt, die Storno-Gutschrift mindert separat den
 * Stornierungsmonat — ueber alle Monate hinweg gleicht sich das fuer den Kunden exakt aus.
 * Kein zweites, eigenes Vorzeichen-/Anteilsverfahren — `topCustomers` summiert `netShareCents`
 * unveraendert, identisch zu `monthlyRevenue`.
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
 * sortiert. Nur `status !== "DRAFT"` (CANCELLED zaehlt mit, siehe Modulkommentar).
 * `limit` wird hier NICHT validiert (z. B. negative/sehr grosse Werte) — das uebernimmt die
 * Boundary (API-Route/MCP-Tool, Phase 12e Task 5) per Zod, bevor `opts` hier ankommt.
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
      status: { not: "DRAFT" },
      issueDate: { gte: start, lt: end },
    },
    select: {
      customerId: true,
      netTotalCents: true,
      grossTotalCents: true,
      payableCents: true,
      customer: { select: { name: true } },
    },
  });

  const buckets = new Map<string, TopCustomer>();
  for (const r of rows) {
    const existing = buckets.get(r.customerId) ?? { customerId: r.customerId, name: r.customer.name, netCents: 0, invoiceCount: 0 };
    existing.netCents += netShareCents(r);
    existing.invoiceCount += 1;
    buckets.set(r.customerId, existing);
  }

  return [...buckets.values()].sort((a, b) => b.netCents - a.netCents).slice(0, limit);
}
