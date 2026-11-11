"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

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

  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    // Aktiven Tab in der einzeiligen, scrollbaren Leiste sichtbar halten (mobil).
    activeRef.current?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [active]);

  return (
    <nav aria-label="Status" className="flex snap-x gap-1 overflow-x-auto whitespace-nowrap border-b border-rule">
      {tabs.map((tab) => {
        const isActive = tab.value === active;
        return (
          <Link
            key={tab.value}
            href={hrefFor(tab.value)}
            ref={isActive ? activeRef : undefined}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "-mb-px inline-flex min-h-10 shrink-0 snap-center items-center border-b-2 border-pen px-3 text-sm font-medium text-pen"
                : "-mb-px inline-flex min-h-10 shrink-0 snap-center items-center border-b-2 border-transparent px-3 text-sm font-medium text-ink-muted hover:border-rule-strong hover:text-ink"
            }
          >
            {tab.label}
            {tab.count != null && <span className="tabular ml-1.5 text-xs text-ink-muted">{tab.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
