/**
 * Gemeinsamer Kern fuer Auswertungen/Grafiken ueber REST (`GET /api/v1/Report`) und MCP
 * (`get_report`) — Phase 12e, Task 5. `runReport` ist die EINZIGE Stelle, die den
 * `type`-Parameter auf eine der vier bestehenden Reporting-Domainfunktionen (Task 2/3,
 * `src/domain/reporting/{revenue,customers,status,payment-behaviour}.ts`) umschaltet;
 * weder die REST-Route noch das MCP-Tool bauen eine eigene Aggregation (§1.4, kein
 * Doppelbau) — beide validieren zudem mit demselben `reportQuerySchema` (ein Schema,
 * kein zweites fuer die jeweils andere Schnittstelle, §50).
 *
 * `limit`/`months` werden HIER (Boundary) per Zod begrenzt — `topCustomers`/
 * `monthlyRevenue` selbst validieren ihre Optionen nicht (siehe deren Modulkommentare).
 *
 * Rueckgabeform bleibt fuer alle vier Typen stabil: `{ objectName: "Report", type, rows }`.
 * `payment-behaviour` liefert genau EIN Ergebnisobjekt (keine Liste über die Zeit) —
 * verpackt trotzdem als `rows: [behaviour]`, damit Konsumenten nicht zwischen
 * "rows ist ein Array" und "rows ist ein Objekt" unterscheiden muessen.
 */
import { z } from "zod";
import { monthlyRevenue } from "./revenue";
import { topCustomers } from "./customers";
import { statusCounts } from "./status";
import { paymentBehaviour } from "./payment-behaviour";

export const reportQuerySchema = z.object({
  type: z.enum(["revenue", "top-customers", "status", "payment-behaviour"]),
  months: z.coerce.number().int().min(1).max(36).default(12),
  limit: z.coerce.number().int().min(1).max(50).default(5),
  customerId: z.string().min(1).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/**
 * Parst `raw` mit `reportQuerySchema` (wirft `ZodError` bei ungueltigem `type`/`months`/
 * `limit` — von der REST-Route auf 400 VALIDATION gemappt) und liefert die passende
 * Auswertung der Organisation. `now` ist ausschliesslich fuer Tests gedacht (dieselbe
 * Konvention wie in den darunterliegenden Reporting-Funktionen).
 */
export async function runReport(orgId: string, raw: unknown, now?: Date): Promise<unknown> {
  const q = reportQuerySchema.parse(raw);
  switch (q.type) {
    case "revenue": {
      const rows = await monthlyRevenue(orgId, { months: q.months, customerId: q.customerId, now });
      return { objectName: "Report", type: q.type, rows };
    }
    case "top-customers": {
      const rows = await topCustomers(orgId, { months: q.months, limit: q.limit, now });
      return { objectName: "Report", type: q.type, rows };
    }
    case "status": {
      const rows = await statusCounts(orgId, now ?? new Date());
      return { objectName: "Report", type: q.type, rows };
    }
    case "payment-behaviour": {
      const behaviour = await paymentBehaviour(orgId, { customerId: q.customerId });
      return { objectName: "Report", type: q.type, rows: [behaviour] };
    }
  }
}
