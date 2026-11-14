import type { serializeBankImportResult } from "@/api/serializers/bank";
import { IMPORT_WARNING_LABELS, skippedReasonLabel } from "./bank-view";

export type BankImportResultView = ReturnType<typeof serializeBankImportResult>;

/** Ergebnis bzw. Vorschau eines Kontoauszug-Imports: neu, Duplikate, verworfen, Warnungen und Verwerfungsgruende. */
export function BankImportResult({ result }: { result: BankImportResultView }) {
  const imported = result.status === "imported";
  return (
    <section aria-label="Importergebnis" className="space-y-3 rounded-md border border-rule bg-paper p-4 text-sm">
      <p className="font-medium text-ink">
        {imported ? "Importiert" : "Vorschau"} · {result.format} {result.schemaVersion} · Konto {result.accountIban}
      </p>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-ink-soft">
        <li>
          <span className="font-medium text-ink">{result.importedCount}</span> neu
        </li>
        <li>
          <span className="font-medium text-ink">{result.duplicateCount}</span> Duplikate
        </li>
        <li>
          <span className="font-medium text-ink">{result.skippedCount}</span> verworfen
        </li>
        {result.returnCount > 0 && (
          <li>
            <span className="font-medium text-ink">{result.returnCount}</span> Rückbuchungen
          </li>
        )}
      </ul>
      {result.duplicateOf && (
        <p className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-seal">
          Diese Datei wurde bereits importiert{result.duplicateOf.importedAt ? ` (${new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin" }).format(new Date(result.duplicateOf.importedAt))})` : ""}.
        </p>
      )}
      {result.warnings.length > 0 && (
        <ul className="space-y-1" aria-label="Warnungen">
          {result.warnings.map((w) => (
            <li key={w} className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-seal">
              {IMPORT_WARNING_LABELS[w] ?? w}
            </li>
          ))}
        </ul>
      )}
      {Object.keys(result.skippedReasons).length > 0 && (
        <div>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Verworfen nach Grund</p>
          <ul className="mt-1 text-ink-soft">
            {Object.entries(result.skippedReasons).map(([code, n]) => (
              <li key={code}>
                {n} × {skippedReasonLabel(code)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
