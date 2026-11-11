import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { formatRate } from "@/domain/fx/decimal";
import type { ExchangeRateRow } from "@/domain/fx/store";

const MONTH_FORMAT = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY_FORMAT = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

const ORIGIN_LABEL: Record<string, string> = { IMPORTED: "Abruf", COMPUTED: "Berechnet", MANUAL: "Manuell" };

const COLUMNS: DataColumn<ExchangeRateRow>[] = [
  { key: "currency", header: "Währung", mobile: "title", cell: (r) => r.currency },
  {
    key: "date",
    header: "Datum",
    mobile: "meta",
    cell: (r) => (r.source === "MONTHLY" ? MONTH_FORMAT.format(r.rateDate) : DAY_FORMAT.format(r.rateDate)),
  },
  { key: "rate", header: "Kurs (je 1 EUR)", align: "right", mobile: "amount", cell: (r) => formatRate(r.rateMicros, "de-DE") },
  { key: "source", header: "Quelle", mobile: "meta", cell: (r) => (r.source === "MONTHLY" ? "Monatsdurchschnitt" : "EZB-Tageskurs") },
  { key: "origin", header: "Herkunft", mobile: "meta", cell: (r) => ORIGIN_LABEL[r.origin] ?? r.origin },
];

/** Kurstabelle (Server-Komponente): Waehrung, Datum, Kurs, Quelle, Herkunft. */
export function ExchangeRateTable({ rows }: { rows: ExchangeRateRow[] }) {
  return (
    <DataTable
      rows={rows}
      columns={COLUMNS}
      rowKey={(r) => r.id}
      caption="Gespeicherte Wechselkurse"
      empty={{ text: "Noch keine Kurse gespeichert. Kurse abrufen oder einen Monatskurs pflegen." }}
    />
  );
}
