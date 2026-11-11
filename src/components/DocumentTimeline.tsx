"use client";

import { useEffect, useState } from "react";

type TimelineKind = "INVOICE" | "QUOTE" | "DELIVERY_NOTE";

interface TimelineEntry {
  at: string;
  kind: "activity" | "email" | "payment" | "dunning" | "milestone";
  label: string;
  detail?: string;
  actor?: string;
}

const ROUTE: Record<TimelineKind, (id: string) => string> = {
  INVOICE: (id) => `/api/invoices/${id}/timeline`,
  QUOTE: (id) => `/api/documents/${id}/timeline`,
  DELIVERY_NOTE: (id) => `/api/delivery-notes/${id}/timeline`,
};

const KIND_DOT: Record<TimelineEntry["kind"], string> = {
  activity: "bg-ink-muted",
  email: "bg-pen",
  payment: "bg-ledger",
  dunning: "bg-stamp",
  milestone: "bg-seal",
};

function deDateTime(iso: string) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** Zeitstrahl eines Belegs (Task 4) — Rechnung/Angebot/AB/Lieferschein-Detail. */
export function DocumentTimeline({ kind, docId }: { kind: TimelineKind; docId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(ROUTE[kind](docId))
      .then((res) => {
        if (!res.ok) throw new Error("Zeitstrahl konnte nicht geladen werden.");
        return res.json() as Promise<{ entries: TimelineEntry[] }>;
      })
      .then((j) => {
        if (!cancelled) setEntries(j.entries);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Fehler");
      });
    return () => {
      cancelled = true;
    };
  }, [kind, docId]);

  if (error) return <p className="text-sm text-stamp">{error}</p>;
  if (!entries) return <p className="text-sm text-ink-muted">Lade Zeitstrahl…</p>;
  if (entries.length === 0) return <p className="text-sm text-ink-muted">Noch keine Ereignisse.</p>;

  return (
    <details open={entries.length <= 5} className="rounded-[var(--radius-card)] bg-sheet px-4 py-3 shadow-[var(--shadow-card)]">
      <summary className="cursor-pointer list-none text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        Zeitstrahl <span className="font-normal text-ink-muted">({entries.length} Ereignisse)</span>
      </summary>
      <ol className="mt-3 space-y-3">
      {[...entries].reverse().map((e, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[e.kind]}`} />
          <div className="text-sm">
            <div className="text-ink">
              {e.label}
              {e.detail && <span className="text-ink-muted"> — {e.detail}</span>}
            </div>
            <div className="text-xs text-ink-muted">
              {deDateTime(e.at)}
              {e.actor && ` · ${e.actor}`}
            </div>
          </div>
        </li>
      ))}
      </ol>
    </details>
  );
}
