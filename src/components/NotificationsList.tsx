"use client";

import { useState } from "react";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/components/shell/UnreadBadge";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

function deDateTime(iso: string) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** Volle Benachrichtigungsliste (`/benachrichtigungen`, Task 4) — einzeln oder alle als
 *  gelesen markieren. */
export function NotificationsList({ initial }: { initial: Notification[] }) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function markRead(ids?: string[]) {
    setBusy(true);
    const res = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids ? { ids } : { all: true }),
    });
    if (res.ok) {
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => (ids ? (ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n) : { ...n, readAt: n.readAt ?? now })));
      // Sidebar-Badge (`UnreadBadge`) rendert server-seitig einen Startwert und aktualisiert
      // sich sonst nur per 60s-Poll/Fokus — dieses Event macht "Alle als gelesen markieren"
      // sofort sichtbar (Abschluss-Review, Important).
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
    }
    setBusy(false);
  }

  const unreadCount = items.filter((n) => !n.readAt).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-muted">{unreadCount} ungelesen</span>
        <button
          type="button"
          onClick={() => void markRead()}
          disabled={busy || unreadCount === 0}
          className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-50"
        >
          Alle als gelesen markieren
        </button>
      </div>

      <ul className="divide-y divide-rule rounded-[var(--radius-card)] border border-rule bg-sheet">
        {items.map((n) => (
          <li key={n.id} className={`flex items-start justify-between gap-3 px-4 py-3 text-sm ${n.readAt ? "" : "bg-pen-wash/50"}`}>
            <div>
              {n.link ? (
                <a href={n.link} className="font-medium text-ink hover:underline">
                  {n.title}
                </a>
              ) : (
                <div className="font-medium text-ink">{n.title}</div>
              )}
              {n.body && <div className="text-ink-muted">{n.body}</div>}
              <div className="text-xs text-ink-muted">{deDateTime(n.createdAt)}</div>
            </div>
            {!n.readAt && (
              <button type="button" onClick={() => void markRead([n.id])} className="shrink-0 text-xs text-pen hover:underline">
                gelesen
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="px-4 py-8 text-center text-ink-muted">Keine Benachrichtigungen.</li>}
      </ul>
    </div>
  );
}
