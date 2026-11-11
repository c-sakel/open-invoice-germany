"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  allTypes: [string, string][]; // [key, label]
  /** Pflicht-Alarme (Phase 16a): immer aktiv, nicht abwaehlbar. */
  mandatoryTypes: string[];
  initial: { enabledTypes: string[]; emailDigest: boolean };
}

/** Task 4: Einstellungen -> Benachrichtigungen — welche Typen erzeugen In-App-
 *  Benachrichtigungen, optional taeglicher E-Mail-Digest. */
export function NotificationSettingsForm({ allTypes, mandatoryTypes, initial }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState<Set<string>>(new Set(initial.enabledTypes));
  const [emailDigest, setEmailDigest] = useState(initial.emailDigest);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/notification-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTypes: Array.from(enabled), emailDigest }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Speichern fehlgeschlagen.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <div className="space-y-2">
        {allTypes.map(([key, label]) => {
          // Fix-Welle (S4): EMAIL_BOUNCED hat aktuell keinen Erzeuger im laufenden System
          // (markEmailBounced wird von keiner Route/keinem MCP-Tool aufgerufen — kein
          // Bounce-Webhook angebunden) — die Checkbox waere ohne Hinweis irrefuehrend
          // ("aktiviert", aber es passiert nie etwas), deshalb deaktiviert + Hinweistext.
          const mandatory = mandatoryTypes.includes(key);
          const disabled = key === "EMAIL_BOUNCED" || mandatory;
          return (
            <label key={key} className={`flex items-center gap-2 text-sm ${disabled && !mandatory ? "text-ink-muted" : "text-ink-soft"}`}>
              <input
                type="checkbox"
                checked={mandatory || enabled.has(key)}
                onChange={() => toggle(key)}
                disabled={disabled}
                className="h-4 w-4 rounded border-rule-strong"
              />
              {label}
              {mandatory && <span className="text-xs italic text-ink-muted">(immer aktiv — GoBD-Pflicht-Alarm)</span>}
              {key === "EMAIL_BOUNCED" && <span className="text-xs italic">(noch nicht aktiv — kein Bounce-Empfang angebunden)</span>}
            </label>
          );
        })}
      </div>
      <label className="flex items-center gap-2 border-t border-rule pt-4 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={emailDigest}
          onChange={(e) => {
            setEmailDigest(e.target.checked);
            setSaved(false);
          }}
          className="h-4 w-4 rounded border-rule-strong"
        />
        Täglichen E-Mail-Digest versenden
      </label>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={busy} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          {busy ? "Speichert…" : "Speichern"}
        </button>
        {saved && <span className="text-xs text-ledger">Gespeichert.</span>}
        {error && <span className="text-xs text-stamp">{error}</span>}
      </div>
    </div>
  );
}
