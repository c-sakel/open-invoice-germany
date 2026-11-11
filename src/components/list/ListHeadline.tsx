/**
 * Kopfkennzahlen ueber einer Liste (Phase 13a, Task 4, §40) — reine Anzeige-Komponente.
 * Jede Zahl kommt aus einer Domain-Funktion ueber die GEFILTERTE Menge (z. B.
 * `invoiceListHeadline`), nie aus den sichtbaren Zeilen der aktuellen Seite — ersetzt die
 * bisherige "nur diese Seite"-Summenzeile (siehe Task-4-Brief-Ruling).
 */
export interface HeadlineItem {
  label: string;
  value: string;
  tone?: "default" | "danger";
  hint?: string;
}

export function ListHeadline({ items }: { items: HeadlineItem[] }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-[var(--radius-card)] border border-rule bg-sheet px-4 py-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{item.label}</dt>
          <dd className={`tabular mt-1 text-xl font-semibold ${item.tone === "danger" ? "text-stamp" : "text-ink"}`}>{item.value}</dd>
          {item.hint && <p className="mt-1 text-xs text-ink-muted">{item.hint}</p>}
        </div>
      ))}
    </dl>
  );
}
