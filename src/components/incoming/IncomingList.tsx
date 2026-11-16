import Link from "next/link";
import type { serializeIncomingHeader } from "@/api/serializers/incoming";
import {
  INCOMING_TABS,
  TAB_LABELS,
  VALIDATION_FILTERS,
  formatIncomingMoney,
  formatIsoDay,
  formatLabel,
  formatReceivedAt,
  isOverdue,
  statusLabel,
  tabCount,
  validationLabel,
  type IncomingTab,
  type ValidationFilter,
} from "./incoming-ui";

export type IncomingRowView = ReturnType<typeof serializeIncomingHeader>;

interface Props {
  rows: IncomingRowView[];
  tab: IncomingTab;
  /** Anzahl je Bearbeitungsstatus plus DUE_SOON. */
  counts: Record<string, number>;
  /** Anzahl je Prüfstatus (für die Auswahl). */
  validationCounts: Record<string, number>;
  pruefung: ValidationFilter | null;
  page: number;
  pageCount: number;
  /** Heutiger Berliner Kalendertag (YYYY-MM-DD) für die Markierung "überfällig". */
  today: string;
  /** Namen zugeordneter Kontakte je Kontakt-Id. */
  contactNames?: Record<string, string>;
}

function href(tab: IncomingTab, pruefung: ValidationFilter | null, page?: number): string {
  const q = new URLSearchParams();
  if (tab !== "ALL") q.set("tab", tab);
  if (pruefung) q.set("pruefung", pruefung);
  if (page && page > 1) q.set("page", String(page));
  const s = q.toString();
  return s === "" ? "/eingang" : `/eingang?${s}`;
}

/** Lieferant der Zeile: Datei, sonst Kopfdaten von Hand (gekennzeichnet), sonst zugeordneter Kontakt. */
export function supplierOf(r: IncomingRowView, contactNames: Record<string, string> = {}): { name: string | null; manual: boolean } {
  if (r.supplierName) return { name: r.supplierName, manual: false };
  if (r.manual?.supplierName) return { name: r.manual.supplierName, manual: true };
  const c = r.supplierContactId ? contactNames[r.supplierContactId] : undefined;
  return { name: c ?? null, manual: false };
}

/** Liste der Eingangsrechnungen mit Reitern nach Bearbeitungsstatus und Filter nach Prüfstatus. Texte aus Dateien erscheinen nur als Text. */
export function IncomingList({ rows, tab, counts, validationCounts, pruefung, page, pageCount, today, contactNames }: Props) {
  return (
    <div className="space-y-4">
      <nav aria-label="Bearbeitungsstatus" className="flex flex-wrap gap-2 text-sm">
        {INCOMING_TABS.map((t) => (
          <Link
            key={t}
            href={href(t, pruefung)}
            aria-current={t === tab ? "page" : undefined}
            className={`rounded-md border px-3 py-1 ${t === tab ? "border-pen bg-pen/10 font-medium text-ink" : "border-rule text-ink-soft hover:bg-paper"}`}
          >
            {TAB_LABELS[t]} ({tabCount(t, counts)})
          </Link>
        ))}
      </nav>

      <form method="get" action="/eingang" className="flex flex-wrap items-center gap-2 text-sm">
        {tab !== "ALL" ? <input type="hidden" name="tab" value={tab} /> : null}
        <label className="flex items-center gap-2">
          <span className="text-ink-soft">Prüfung</span>
          <select name="pruefung" defaultValue={pruefung ?? ""} className="rounded-md border border-rule-strong bg-sheet px-2 py-1.5 text-sm">
            <option value="">Alle</option>
            {VALIDATION_FILTERS.map((v) => (
              <option key={v} value={v}>
                {validationLabel(v)} ({validationCounts[v] ?? 0})
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-rule-strong px-3 py-1.5 text-sm text-ink-soft hover:bg-paper">
          Filtern
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-rule bg-paper px-3 py-6 text-center text-sm text-ink-muted">Keine Eingangsrechnungen in dieser Ansicht.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const supplier = supplierOf(r, contactNames);
            const overdue = isOverdue(r.status, r.dueAt, today);
            const amount = r.payableCents ?? r.grossCents ?? r.manual?.grossCents ?? null;
            return (
              <li key={r.id} className="rounded-md border border-rule bg-sheet p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/eingang/${r.id}`} className="font-medium text-ink underline break-words">
                      {supplier.name ?? "Lieferant unbekannt"}
                    </Link>
                    {supplier.manual ? <span className="ml-2 text-xs text-ink-muted">(von Hand)</span> : null}
                    <p className="text-ink-soft break-words">Nummer: {r.number ?? r.manual?.number ?? "–"}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-ink">{formatIncomingMoney(amount, r.currency ?? r.manual?.currency ?? null)}</p>
                    <p className="text-ink-muted">
                      fällig {formatIsoDay(r.dueAt)}
                      {overdue ? <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-900">überfällig</span> : null}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                  <span className="font-medium text-ink-soft">{statusLabel(r.status)}</span>
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
            );
          })}
        </ul>
      )}

      {pageCount > 1 && (
        <nav aria-label="Seiten" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={href(tab, pruefung, page - 1)} className="underline">← Vorherige</Link> : <span />}
          <span className="text-ink-muted">
            Seite {page} von {pageCount}
          </span>
          {page < pageCount ? <Link href={href(tab, pruefung, page + 1)} className="underline">Nächste →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
