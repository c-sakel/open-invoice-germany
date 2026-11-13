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
 * Phase 17c, Task 3: `format` ("json" | "csv") ist fuer jeden Typ zulaessig und steht bewusst
 * NICHT in `APPLICABLE_PARAMS`; `runReport` liefert immer das typisierte `ReportResult`, die
 * Aufrufer (REST, MCP, Session-Route `/api/reports/<typ>.csv`) entscheiden ueber die
 * Darstellung (`reportToCsv` in csv.ts).
 *
 * Rueckgabeform bleibt fuer alle vier Typen stabil: `{ objectName: "Report", type, rows }`.
 * `payment-behaviour` liefert genau EIN Ergebnisobjekt (keine Liste über die Zeit) —
 * verpackt trotzdem als `rows: [behaviour]`, damit Konsumenten nicht zwischen
 * "rows ist ein Array" und "rows ist ein Objekt" unterscheiden muessen.
 *
 * Fix M7 (Abschluss-Review): jedes Feld traegt `.describe()` — REST ignoriert das
 * (Zod-Metadaten ohne Wirkung auf `.parse()`), das MCP-Tool `get_report`
 * (`src/mcp/tools/system.ts`) baut sein `inputSchema` aus `reportQueryFieldsSchema.shape`
 * (single source, kein zweites, redundant getipptes Feld-Set) und uebernimmt die
 * Beschreibungen.
 *
 * Fix M8 (Fix 2, Koordinator-Ruling): `months`/`limit`/`customerId`, die beim gewaehlten
 * `type` nicht anwendbar sind, wurden bisher STILLSCHWEIGEND ignoriert (z. B. `limit` bei
 * `type=revenue`) — das widersprach der eigenen API-Doku nicht, war aber fuer Aufrufer
 * unbemerkbar falsch benutzbar. `reportQuerySchema` lehnt einen explizit uebergebenen,
 * nicht anwendbaren Parameter jetzt per `superRefine` mit 400 VALIDATION ab (REST) bzw.
 * einer lesbaren Fehlermeldung (MCP) ab — die Meldung nennt den betroffenen Parameter.
 *
 * `months`/`limit` tragen deshalb bewusst KEIN `.default()` mehr auf Schema-Ebene: Zod
 * wendet Feld-Defaults VOR einem angehaengten `.superRefine()` an (`.parse()` liefert dem
 * Refinement bereits den defaulteten Wert) — ein weggelassener, aber anwendbarer Parameter
 * waere von einem explizit uebergebenen, nicht anwendbaren Parameter mit demselben Wert
 * nicht mehr unterscheidbar. Die Defaults (12/5) werden deshalb NACH der Validierung in
 * `runReport` angewendet, nur fuer den Fall, dass der Parameter beim gewaehlten `type`
 * ueberhaupt zaehlt.
 *
 * `reportQueryFieldsSchema` (das unrefinierte Basisschema) bleibt separat exportiert:
 * ein Zod-Objektschema mit `.superRefine()` erlaubt kein `.omit()`/`.pick()`/`.partial()`
 * mehr (wirft zur Laufzeit) — `src/mcp/tools/system.ts` braucht `.omit({customerId:true})`
 * fuer sein `inputSchema` und muss deshalb auf dieser Basis statt auf `reportQuerySchema`
 * selbst aufbauen.
 */
import { z } from "zod";
import { monthlyRevenueByCurrency } from "./revenue";
import { topCustomers } from "./customers";
import { statusCounts } from "./status";
import { paymentBehaviour } from "./payment-behaviour";
import { monthlyCashIn } from "./cash-in";
import { quoteOutcome } from "./quote-outcome";
import { topProducts } from "./top-products";
import { recurringRunRate, type RunRateRow } from "./recurring-run-rate";
import type { CurrencyRevenuePoint } from "./revenue";
import type { TopCustomer } from "./customers";
import type { StatusCount } from "./status";
import type { PaymentBehaviour } from "./payment-behaviour";
import type { CashInPoint } from "./cash-in";
import type { QuoteOutcomeRow } from "./quote-outcome";
import type { TopProduct } from "./top-products";

export const reportQueryFieldsSchema = z.object({
  type: z
    .enum(["revenue", "top-customers", "status", "payment-behaviour", "cash-in", "quote-outcome", "top-products", "recurring-run-rate"])
    .describe(
      "Art der Auswertung: revenue (Umsatz je Monat und Währung), top-customers, status (Belege je Status), payment-behaviour, cash-in (Zahlungseingang je Monat und Währung, ohne Skonto/Gutschrift-Verrechnung, Gegenbuchungen negativ), quote-outcome (Angebotsquote), top-products (Nettoumsatz je Produkt), recurring-run-rate (monatlich wiederkehrender Netto-Umsatz aktiver Abos).",
    ),
  months: z.coerce.number().int().min(1).max(36).optional().describe("Anzahl Kalendermonate rückwirkend (1–36, Default 12) — nur bei revenue, top-customers, cash-in, quote-outcome und top-products zulässig."),
  limit: z.coerce.number().int().min(1).max(50).optional().describe("Maximale Anzahl Zeilen (1–50, Default 5; bei top-products Default 10, je Währung) — nur bei top-customers und top-products zulässig."),
  format: z.enum(["json", "csv"]).optional().describe("Ausgabeformat: json (Default) oder csv (deutsches Format, Semikolon, Dezimalkomma) — bei jedem type zulässig; wird von den Aufrufern (REST/MCP) gelesen, nicht von runReport."),
  customerId: z.string().min(1).optional().describe("Auf einen Kunden einschränken — nur bei revenue und payment-behaviour zulässig."),
  currency: z.string().regex(/^[A-Z]{3}$/, "Währung als dreistelliger Großbuchstaben-Code (z. B. EUR).").optional().describe("Nur Belege dieser Währung (ISO-4217, z. B. EUR) — nur bei revenue zulässig; ohne Angabe je Währung eine eigene Zeilenreihe."),
});

type ReportType = z.infer<typeof reportQueryFieldsSchema>["type"];
type ApplicableParam = "months" | "limit" | "customerId" | "currency";

/** Je `type` die Parameter, die ueberhaupt eine Wirkung haben (siehe `runReport`-Switch). */
const APPLICABLE_PARAMS: Record<ReportType, ReadonlySet<ApplicableParam>> = {
  revenue: new Set(["months", "customerId", "currency"]),
  "top-customers": new Set(["months", "limit"]),
  status: new Set([]),
  "payment-behaviour": new Set(["customerId"]),
  "cash-in": new Set(["months"]),
  "quote-outcome": new Set(["months"]),
  "top-products": new Set(["months", "limit"]),
  "recurring-run-rate": new Set([]),
};

export const reportQuerySchema = reportQueryFieldsSchema.superRefine((q, ctx) => {
  const allowed = APPLICABLE_PARAMS[q.type];
  for (const key of ["months", "limit", "customerId", "currency"] as const) {
    if (q[key] !== undefined && !allowed.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Parameter "${key}" ist bei type="${q.type}" nicht zulässig.`,
      });
    }
  }
});

/**
 * Parst `raw` mit `reportQuerySchema` (wirft `ZodError` bei ungueltigem `type`, `months`/
 * `limit` ausserhalb ihrer Grenzen ODER einem beim gewaehlten `type` nicht anwendbaren
 * Parameter — von der REST-Route auf 400 VALIDATION gemappt, vom MCP-Tool auf eine
 * lesbare Fehlermeldung) und liefert die passende Auswertung der Organisation. `now` ist
 * ausschliesslich fuer Tests gedacht (dieselbe Konvention wie in den darunterliegenden
 * Reporting-Funktionen).
 */
export type ReportResult =
  | { objectName: "Report"; type: "revenue"; rows: CurrencyRevenuePoint[] }
  | { objectName: "Report"; type: "top-customers"; rows: TopCustomer[] }
  | { objectName: "Report"; type: "status"; rows: StatusCount[] }
  | { objectName: "Report"; type: "payment-behaviour"; rows: [PaymentBehaviour] }
  | { objectName: "Report"; type: "cash-in"; rows: CashInPoint[] }
  | { objectName: "Report"; type: "quote-outcome"; rows: QuoteOutcomeRow[] }
  | { objectName: "Report"; type: "top-products"; rows: TopProduct[] }
  | { objectName: "Report"; type: "recurring-run-rate"; rows: RunRateRow[] };

export async function runReport(orgId: string, raw: unknown, now?: Date): Promise<ReportResult> {
  const q = reportQuerySchema.parse(raw);
  const months = q.months ?? 12;
  const limit = q.limit ?? 5;
  switch (q.type) {
    case "revenue": {
      const rows = await monthlyRevenueByCurrency(orgId, { months, customerId: q.customerId, currency: q.currency, now });
      return { objectName: "Report", type: q.type, rows };
    }
    case "top-customers": {
      const rows = await topCustomers(orgId, { months, limit, now });
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
    case "cash-in": {
      const rows = await monthlyCashIn(orgId, { months, now });
      return { objectName: "Report", type: q.type, rows };
    }
    case "quote-outcome": {
      const rows = await quoteOutcome(orgId, { months, now });
      return { objectName: "Report", type: q.type, rows };
    }
    case "top-products": {
      const rows = await topProducts(orgId, { months, limit: q.limit ?? 10, now });
      return { objectName: "Report", type: q.type, rows };
    }
    case "recurring-run-rate": {
      const rows = await recurringRunRate(orgId);
      return { objectName: "Report", type: q.type, rows };
    }
  }
}
