// src/components/detail/StatusCard.tsx
import type { ReactNode } from "react";

export interface StatusRow {
  label: string;
  value: ReactNode;
}

export function StatusCard({
  title = "Status",
  status,
  rows,
  children,
}: {
  title?: string;
  status: ReactNode;
  rows: StatusRow[];
  children?: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-ink">{title}</h2>
        <div className="flex flex-wrap items-center gap-1">{status}</div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className="text-right text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}
