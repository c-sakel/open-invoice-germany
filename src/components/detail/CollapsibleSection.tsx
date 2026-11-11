// src/components/detail/CollapsibleSection.tsx
import type { ReactNode } from "react";

export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="rounded-[var(--radius-card)] border border-rule bg-sheet">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink">
        <span>{title}</span>
        {summary && <span className="font-normal text-ink-muted">{summary}</span>}
      </summary>
      <div className="border-t border-rule p-4">{children}</div>
    </details>
  );
}
