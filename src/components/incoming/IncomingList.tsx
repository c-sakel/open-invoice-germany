import Link from "next/link";
import type { serializeIncomingHeader } from "@/api/serializers/incoming";
import { INCOMING_TABS, TAB_LABELS, formatIncomingMoney, formatIsoDay, formatLabel, formatReceivedAt, validationLabel, type IncomingTab } from "./incoming-ui";

export type IncomingRowView = ReturnType<typeof serializeIncomingHeader>;

interface Props {
  rows: IncomingRowView[];
  tab: IncomingTab;
  counts: Record<string, number>;
  page: number;
  pageCount: number;
}

const tabHref = (t: IncomingTab, page?: number) => `/eingang?tab=${t}${page && page > 1 ? `&page=${page}` : ""}`;

/** Liste der Eingangsrechnungen mit Reitern nach Prüfstatus. Alle Texte aus Dateien erscheinen nur als Text. */
export function IncomingList({ rows, tab, counts, page, pageCount }: Props) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return (
    <div className="space-y-4">
      <nav aria-label="Prüfstatus" className="flex flex-wrap gap-2 text-sm">
        {INCOMING_TABS.map((t) => (
          <Link
            key={t}
            href={tabHref(t)}
            aria-current={t === tab ? "page" : undefined}
            className={`rounded-md border px-3 py-1 ${t === tab ? "border-pen bg-pen/10 font-medium text-ink" : "border-rule text-ink-soft hover:bg-paper"}`}
          >
            {TAB_LABELS[t]} ({t === "ALL" ? total : (counts[t] ?? 0)})
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-md border border-rule bg-paper px-3 py-6 text-center text-sm text-ink-muted">Keine Eingangsrechnungen in dieser Ansicht.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-md border border-rule bg-sheet p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/eingang/${r.id}`} className="font-medium text-ink underline break-words">
                    {r.supplierName ?? "Lieferant unbekannt"}
                  </Link>
                  <p className="text-ink-soft break-words">Nummer: {r.number ?? "–"}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-ink">{formatIncomingMoney(r.payableCents ?? r.grossCents, r.currency)}</p>
                  <p className="text-ink-muted">fällig {formatIsoDay(r.dueDate)}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                <span>Eingang {formatReceivedAt(r.receivedAt)}</span>
                <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{formatLabel(r)}</span>
                <span>Prüfung: {validationLabel(r.validationStatus)}</span>
                {r.duplicateOfId ? (
                  <Link href={`/eingang/${r.duplicateOfId}`} className="text-seal underline">
                    Mögliche Dublette
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav aria-label="Seiten" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={tabHref(tab, page - 1)} className="underline">← Vorherige</Link> : <span />}
          <span className="text-ink-muted">
            Seite {page} von {pageCount}
          </span>
          {page < pageCount ? <Link href={tabHref(tab, page + 1)} className="underline">Nächste →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
