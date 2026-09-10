import Link from "next/link";

/**
 * Status-Tabs ueber einer Liste (Phase 13a, §40) — Links auf `?status=…`. `offset` faellt
 * beim Tabwechsel weg (neue Auswahl beginnt auf Seite 1), alle uebrigen Filter bleiben.
 * `count: null` zeigt keine Zahl — z. B. wenn der Zaehler mangels Daten nicht berechenbar
 * ist (billingStateIndex-Obergrenze, Task 5): lieber keine Zahl als eine falsche.
 */
export interface StatusTab {
  value: string;
  label: string;
  count?: number | null;
}

export function StatusTabs({
  basePath,
  searchParams,
  tabs,
  active,
}: {
  basePath: string;
  searchParams: Record<string, string | undefined>;
  tabs: StatusTab[];
  active: string;
}) {
  function hrefFor(value: string): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "offset" && k !== "status") params.set(k, v);
    }
    if (value !== "all") params.set("status", value);
    return params.toString() ? `${basePath}?${params.toString()}` : basePath;
  }

  return (
    <nav aria-label="Status" className="flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((tab) => {
        const isActive = tab.value === active;
        return (
          <Link
            key={tab.value}
            href={hrefFor(tab.value)}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "-mb-px border-b-2 border-indigo-600 px-3 py-2 text-sm font-medium text-indigo-700"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:border-slate-300 hover:text-slate-800"
            }
          >
            {tab.label}
            {tab.count != null && <span className="tabular ml-1.5 text-xs text-slate-400">{tab.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
