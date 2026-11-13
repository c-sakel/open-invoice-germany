/**
 * CSV-Export der Auswertungen (Phase 17c, Task 3). Rein: wandelt ein `ReportResult` in
 * Text (Semikolon, CRLF, deutsche Dezimalzahlen, ohne BOM; den BOM setzt der Aufrufer
 * ueber `CSV_BOM`). Nur Textspalten laufen durch `csvTextCell` (Formelschutz gegen
 * Tabellenkalkulations-Injection, z. B. Kundenname `=SUMME(A1)`); Zahlen werden aus
 * Integern formatiert, nie per Float-Rechnung bei Geld.
 *
 * Der Prueferexport (`src/domain/audit/export-csv.ts`) bleibt bewusst unveraendert:
 * GoBD, Rohdaten ohne Entschaerfung.
 *
 * Phase 18b: Schreiber und Formelschutz liegen in `src/domain/export/csv-writer.ts`;
 * `csvTextCell` und `CSV_BOM` werden hier fuer Bestandsimporte re-exportiert.
 */
import { berlinDateKey } from "@/lib/berlin-time";
import { CSV_BOM, col, csvTable, csvTextCell } from "@/domain/export/csv-writer";
import type { ReportResult } from "./query";

export { csvTextCell, CSV_BOM };

type Rows<T extends ReportResult["type"]> = Extract<ReportResult, { type: T }>["rows"][number];

export function reportToCsv(result: ReportResult): string {
  switch (result.type) {
    case "revenue":
      return csvTable<Rows<"revenue">>(
        [col("Monat", "text", (r) => r.month), col("Währung", "text", (r) => r.currency), col("Netto", "cents", (r) => r.netCents), col("Anzahl", "int", (r) => r.count)],
        result.rows,
      );
    case "top-customers":
      return csvTable<Rows<"top-customers">>(
        [
          col("Kunde", "text", (r) => r.name),
          col("Kunden-ID", "text", (r) => r.customerId),
          col("Netto", "cents", (r) => r.netCents),
          col("Rechnungen", "int", (r) => r.invoiceCount),
        ],
        result.rows,
      );
    case "status":
      return csvTable<Rows<"status">>(
        [col("Status", "text", (r) => r.label), col("Anzahl", "int", (r) => r.count), col("Offen", "cents", (r) => r.openCents)],
        result.rows,
      );
    case "payment-behaviour":
      return csvTable<Rows<"payment-behaviour">>(
        [
          col("Ø Tage bis Zahlung", "tenths", (r) => (r.avgDaysToPay === null ? null : Math.round(r.avgDaysToPay * 10))),
          col("Pünktlich (%)", "permille", (r) => (r.onTimeShare === null ? null : Math.round(r.onTimeShare * 1000))),
          col("Bezahlte Rechnungen", "int", (r) => r.paidCount),
        ],
        result.rows,
      );
    case "cash-in":
      return csvTable<Rows<"cash-in">>(
        [
          col("Monat", "text", (r) => r.month),
          col("Währung", "text", (r) => r.currency),
          col("Zahlungseingang", "cents", (r) => r.paidCents),
          col("Rechnungsausgang brutto", "cents", (r) => r.invoicedGrossCents),
        ],
        result.rows,
      );
    case "quote-outcome":
      return csvTable<Rows<"quote-outcome">>(
        [
          col("Währung", "text", (r) => r.currency),
          col("Angenommen", "int", (r) => r.accepted.count),
          col("Angenommen netto", "cents", (r) => r.accepted.netCents),
          col("Abgelehnt", "int", (r) => r.rejected.count),
          col("Abgelehnt netto", "cents", (r) => r.rejected.netCents),
          col("Abgelaufen", "int", (r) => r.expired.count),
          col("Abgelaufen netto", "cents", (r) => r.expired.netCents),
          col("Offen", "int", (r) => r.open.count),
          col("Offen netto", "cents", (r) => r.open.netCents),
          col("Annahmequote (%)", "permille", (r) => r.acceptedPermille),
        ],
        result.rows,
      );
    case "top-products":
      return csvTable<Rows<"top-products">>(
        [
          col("Produkt", "text", (r) => r.name),
          col("Produkt-ID", "text", (r) => r.productId),
          col("Währung", "text", (r) => r.currency),
          col("Netto", "cents", (r) => r.netCents),
          col("Menge", "milli", (r) => r.quantityMilli),
        ],
        result.rows,
      );
    case "recurring-run-rate":
      return csvTable<Rows<"recurring-run-rate">>(
        [
          col("Währung", "text", (r) => r.currency),
          col("Monatlich netto", "cents", (r) => r.monthlyNetCents),
          col("Aktive Abos", "int", (r) => r.activeCount),
          col("Ohne Intervall", "int", (r) => r.skipped),
        ],
        result.rows,
      );
  }
}

/** `auswertung-<type>-<Berliner Datum>.csv`. */
export function reportCsvFilename(type: ReportResult["type"], now: Date): string {
  return `auswertung-${type}-${berlinDateKey(now)}.csv`;
}
