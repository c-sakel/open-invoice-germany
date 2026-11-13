// src/components/detail/CollapsibleSection.tsx
"use client";

import { useRef, type ReactNode } from "react";
import { useDetailsDismiss } from "./use-details-dismiss";

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
  const ref = useRef<HTMLDetailsElement>(null);
  // Inhaltsblock, kein Overlay: nur Escape schliesst, Klick ausserhalb bewusst nicht.
  useDetailsDismiss(ref, { outsideClick: false });
  return (
    <details ref={ref} open={defaultOpen} className="rounded-[var(--radius-card)] border border-rule bg-sheet">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink">
        <span>{title}</span>
        {summary && <span className="font-normal text-ink-muted">{summary}</span>}
      </summary>
      <div className="border-t border-rule p-4">{children}</div>
    </details>
  );
}
