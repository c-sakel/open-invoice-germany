import Link from "next/link";
import type { BankConnectionClientView } from "./bank-fetch-core";
import { connectionStateText, connectionWarnings, formatDateTime } from "./bank-fetch-ui";
import { BankFetchPanel } from "./BankFetchPanel";

/** Bereich "Konten abrufen" im Bankabgleich: Status je Bankzugang und der manuelle Abruf. Nur bei mindestens einem Bankzugang. */
export function BankFetchSection({ connections }: { connections: BankConnectionClientView[] }) {
  if (connections.length === 0) return null;
  return (
    <details className="rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
      <summary className="cursor-pointer font-medium text-ink">Konten abrufen</summary>
      <div className="mt-3 space-y-3">
        <ul className="space-y-1 text-ink-soft" aria-label="Status des Kontoabrufs">
          {connections.map((c) => {
            const warnings = connectionWarnings(c);
            return (
              <li key={c.id}>
                <span className="font-medium text-ink">{c.label}</span>: {connectionStateText(c.state)}
                {c.lastSuccessAt ? `, letzter Erfolg ${formatDateTime(c.lastSuccessAt)}` : ""}
                {c.autoEnabled ? ", täglicher Abruf an" : ""}
                {warnings.map((w) => (
                  <span key={w} className="mt-1 block rounded-md border border-seal/30 bg-seal/10 px-2 py-1 text-seal">
                    {w}
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
        <BankFetchPanel connections={connections} />
        <p className="text-xs text-ink-muted">
          Einrichtung und Protokoll unter{" "}
          <Link href="/einstellungen/kontoabruf" className="text-pen underline">
            Einstellungen, Kontoabruf
          </Link>
          .
        </p>
      </div>
    </details>
  );
}
