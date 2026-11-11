"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Settings {
  autoCreate: boolean;
  autoSend: boolean;
  gracePeriodDays: number;
}

/**
 * Phase 14a, Task 4 (R6): das Formularfeld "Basiszinssatz" (Basispunkte + Stichtag) ist
 * einer eigenen Tabelle gewichen (`BaseRateTable`, unter dieser Karte auf derselben Seite)
 * — ein einzelner Satz konnte Halbjahreswechsel nicht abbilden (Task 3). Das PUT hier
 * sendet deshalb bewusst NICHT mehr `baseInterestRateBp`/`baseRateValidFrom`: ein
 * fehlender Schlüssel laesst `saveDunningSettings` (src/domain/dunning/settings.ts) den
 * bestehenden Spaltenwert unangetastet UND loest keinen Altschreibweg-Upsert in
 * `BaseInterestRate` aus (siehe dortiger Kommentar) — die Tabelle bleibt allein
 * zustaendig fuer die Historie.
 */
export function DunningSettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/dunning-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Speichern fehlgeschlagen.");
      setBusy(false);
      return;
    }
    setBusy(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings.autoCreate} onChange={(e) => setSettings((s) => ({ ...s, autoCreate: e.target.checked }))} className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" />
        <span className="font-medium text-ink-soft">Mahnungen automatisch erstellen (Scheduler)</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings.autoSend} onChange={(e) => setSettings((s) => ({ ...s, autoSend: e.target.checked }))} className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" />
        <span className="font-medium text-ink-soft">Mahnungen automatisch versenden (§26, zusätzlich je Stufe erforderlich)</span>
      </label>
      <label className="flex flex-col gap-1 text-sm sm:w-64">
        <span className="font-medium text-ink-soft">Karenztage (nur erste Stufe)</span>
        <input
          type="number"
          value={settings.gracePeriodDays}
          onChange={(e) => setSettings((s) => ({ ...s, gracePeriodDays: Number(e.target.value) }))}
          className="rounded-md border border-rule-strong px-3 py-2"
        />
      </label>
      {error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-2 text-xs text-stamp">{error}</div>}
      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={busy} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-white hover:bg-pen disabled:opacity-60">
          {busy ? "…" : "Speichern"}
        </button>
        {saved && <span className="text-xs text-ledger">Gespeichert.</span>}
      </div>
    </form>
  );
}
