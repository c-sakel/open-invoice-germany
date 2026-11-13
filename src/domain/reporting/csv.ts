/**
 * CSV-Export der Auswertungen (Phase 17c, Task 3). Rein: wandelt ein `ReportResult` in
 * Text (Semikolon, CRLF, deutsche Dezimalzahlen, ohne BOM; den BOM setzt der Aufrufer
 * ueber `CSV_BOM`). Nur Textspalten laufen durch `csvTextCell` (Formelschutz gegen
 * Tabellenkalkulations-Injection, z. B. Kundenname `=SUMME(A1)`); Zahlen werden aus
 * Integern formatiert, nie per Float-Rechnung bei Geld.
 *
 * Der Prueferexport (`src/domain/audit/export-csv.ts`) bleibt bewusst unveraendert:
 * GoBD, Rohdaten ohne Entschaerfung.
 */
import { berlinDateKey } from "@/lib/berlin-time";
import { formatCentsDe, formatMilliDe } from "@/domain/audit/export-csv";
import type { ReportResult } from "./query";

export const CSV_BOM = "\uFEFF";

/** Textzelle: Formelzeichen am Anfang mit `'` entschaerfen, bei Trennzeichen/Anfuehrung/Umbruch quoten. */
export function csvTextCell(v: string | null): string {
  if (v === null) return "";
  let s = v;
  // Formelschutz (OWASP CSV Injection): auch nach fuehrendem Leerraum und fuer Vollbreite-Varianten.
  if (/^[\s\u3000]*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(s)) s = `'${s}`;
  if (/[;"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

type Kind = "text" | "int" | "cents" | "milli" | "tenths" | "permille";

interface Column<R> {
  header: string;
  kind: Kind;
  get: (r: R) => string | number | null;
}

/** Zehntel/Promille-Wert (bereits auf Integer gerundet) als `12,3`. */
function formatTenths(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.trunc(abs / 10)},${abs % 10}`;
}

function cell(kind: Kind, v: string | number | null): string {
  if (v === null) return "";
  if (kind === "text") return csvTextCell(String(v));
  const n = Number(v);
  switch (kind) {
    case "int":
      return String(n);
    case "cents":
      return formatCentsDe(n);
    case "milli":
      return formatMilliDe(n);
    case "tenths":
    case "permille":
      return formatTenths(n);
  }
}

const col = <R>(header: string, kind: Kind, get: (r: R) => string | number | null): Column<R> => ({ header, kind, get });

function table<R>(columns: Column<R>[], rows: readonly R[]): string {
  const lines = [columns.map((c) => c.header).join(";")];
  for (const r of rows) lines.push(columns.map((c) => cell(c.kind, c.get(r))).join(";"));
  return lines.join("\r\n") + "\r\n";
}

type Rows<T extends ReportResult["type"]> = Extract<ReportResult, { type: T }>["rows"][number];

export function reportToCsv(result: ReportResult): string {
  switch (result.type) {
    case "revenue":
      return table<Rows<"revenue">>(
        [col("Monat", "text", (r) => r.month), col("Währung", "text", (r) => r.currency), col("Netto", "cents", (r) => r.netCents), col("Anzahl", "int", (r) => r.count)],
        result.rows,
      );
    case "top-customers":
      return table<Rows<"top-customers">>(
        [
          col("Kunde", "text", (r) => r.name),
          col("Kunden-ID", "text", (r) => r.customerId),
          col("Netto", "cents", (r) => r.netCents),
          col("Rechnungen", "int", (r) => r.invoiceCount),
        ],
        result.rows,
      );
    case "status":
      return table<Rows<"status">>(
        [col("Status", "text", (r) => r.label), col("Anzahl", "int", (r) => r.count), col("Offen", "cents", (r) => r.openCents)],
        result.rows,
      );
    case "payment-behaviour":
      return table<Rows<"payment-behaviour">>(
        [
          col("Ø Tage bis Zahlung", "tenths", (r) => (r.avgDaysToPay === null ? null : Math.round(r.avgDaysToPay * 10))),
          col("Pünktlich (%)", "permille", (r) => (r.onTimeShare === null ? null : Math.round(r.onTimeShare * 1000))),
          col("Bezahlte Rechnungen", "int", (r) => r.paidCount),
        ],
        result.rows,
      );
    case "cash-in":
      return table<Rows<"cash-in">>(
        [
          col("Monat", "text", (r) => r.month),
          col("Währung", "text", (r) => r.currency),
          col("Zahlungseingang", "cents", (r) => r.paidCents),
          col("Rechnungsausgang brutto", "cents", (r) => r.invoicedGrossCents),
        ],
        result.rows,
      );
    case "quote-outcome":
      return table<Rows<"quote-outcome">>(
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
      return table<Rows<"top-products">>(
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
      return table<Rows<"recurring-run-rate">>(
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
