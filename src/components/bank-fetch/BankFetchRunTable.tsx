import Link from "next/link";
import type { RunSummary } from "@/domain/bank-fetch/run-types";
import { bankFetchErrorText, formatDateTime, formatDay, gapWarning } from "./bank-fetch-ui";

export interface BankFetchRunView {
  id: string;
  startedAt: string;
  trigger: string;
  ibanMasked: string | null;
  from: string | null;
  to: string | null;
  result: string;
  importedCount: number;
  duplicateCount: number;
  importId: string | null;
}

function period(from: string | null, to: string | null): string {
  return from === null || to === null ? "–" : `${formatDay(from)} bis ${formatDay(to)}`;
}

/** Protokoll der letzten Abrufe: feste Texte je Ergebnis, Konto maskiert, kein Banktext. */
export function BankFetchRunTable({ runs }: { runs: BankFetchRunView[] }) {
  if (runs.length === 0) return <p className="text-sm text-ink-muted">Noch keine Abrufe.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">Protokoll der letzten Abrufe</caption>
        <thead className="text-xs text-ink-muted">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">Zeit</th>
            <th scope="col" className="py-1 pr-3 font-medium">Konto</th>
            <th scope="col" className="py-1 pr-3 font-medium">Zeitraum</th>
            <th scope="col" className="py-1 pr-3 font-medium">Ergebnis</th>
            <th scope="col" className="py-1 pr-3 font-medium">Neu / Dubletten</th>
            <th scope="col" className="py-1 font-medium">Import</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-rule align-top">
              <td className="py-1.5 pr-3">
                {formatDateTime(r.startedAt)}
                <span className="block text-xs text-ink-muted">{r.trigger === "AUTO" ? "automatisch" : "manuell"}</span>
              </td>
              <td className="py-1.5 pr-3 font-mono text-xs">{r.ibanMasked ?? "–"}</td>
              <td className="py-1.5 pr-3">{period(r.from, r.to)}</td>
              <td className={`py-1.5 pr-3 ${r.result === "OK" ? "text-ledger" : "text-seal"}`}>{bankFetchErrorText(r.result)}</td>
              <td className="py-1.5 pr-3">
                {r.importedCount} / {r.duplicateCount}
              </td>
              <td className="py-1.5">
                {r.importId ? (
                  <Link href="/bankabgleich" className="text-pen underline">
                    Bankabgleich
                  </Link>
                ) : (
                  "–"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ergebnis eines Abrufs je Konto, mit Hinweis auf eine Lücke im Zeitraum und Link zum Bankabgleich. */
export function FetchRunSummaryList({ runs }: { runs: RunSummary[] }) {
  return (
    <section aria-label="Ergebnis des Abrufs" className="space-y-2 rounded-md border border-rule bg-paper p-3 text-sm">
      <ul className="space-y-1">
        {runs.map((r) => {
          const gap = gapWarning(r);
          return (
            <li key={r.runId}>
              <span className="font-mono text-xs">{r.iban ?? "–"}</span>:{" "}
              <span className={r.result === "OK" ? "text-ledger" : "text-seal"}>{bankFetchErrorText(r.result)}</span>
              {r.result === "OK" ? ` — ${r.importedCount} neu, ${r.duplicateCount} Dubletten` : null}
              {gap ? <span className="block rounded-md border border-seal/30 bg-seal/10 px-2 py-1 text-seal">{gap}</span> : null}
            </li>
          );
        })}
      </ul>
      {runs.some((r) => r.importId !== null) ? (
        <Link href="/bankabgleich" className="inline-block text-pen underline">
          Zum Bankabgleich
        </Link>
      ) : null}
    </section>
  );
}
