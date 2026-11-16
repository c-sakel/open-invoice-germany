import { formatReceivedAt, historyText } from "./incoming-ui";

export interface HistoryItem {
  at: string | null;
  action: string;
  actor: string;
  summary: Record<string, unknown>;
}

/** Verlauf aus dem Änderungsprotokoll (neueste zuerst, wie geliefert). Notiztexte stehen dort nie. */
export function IncomingHistory({ history }: { history: HistoryItem[] }) {
  return (
    <section aria-label="Verlauf" className="space-y-2 rounded-md border border-rule bg-paper p-4 text-sm">
      <h2 className="text-base font-medium text-ink">Verlauf</h2>
      {history.length === 0 ? (
        <p className="text-ink-muted">Noch keine Einträge.</p>
      ) : (
        <ul className="space-y-1">
          {history.map((h, i) => (
            <li key={`${h.at}|${i}`} className="break-words text-ink-soft">
              <span className="text-ink-muted">{formatReceivedAt(h.at)}</span> · {historyText(h)} <span className="text-ink-muted">({h.actor})</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
