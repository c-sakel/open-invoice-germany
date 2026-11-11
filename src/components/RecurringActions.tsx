"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RecurringActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function setStatus(next: "ACTIVE" | "PAUSED" | "ENDED") {
    setBusy(next);
    setError(null);
    const res = await fetch(`/api/recurring/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Änderung fehlgeschlagen.");
      return;
    }
    router.refresh();
  }

  async function runNow() {
    setBusy("run");
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/recurring/${id}/run`, { method: "POST" });
    setBusy(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Erzeugen fehlgeschlagen.");
      return;
    }
    const j = (await res.json()) as { number: string | null; finalized: boolean };
    setInfo(j.number ? `Rechnung ${j.number} erzeugt.` : "Rechnungs-Entwurf erzeugt.");
    router.refresh();
  }

  const btn = "rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === "ACTIVE" && (
          <button onClick={runNow} disabled={busy !== null} className={`${btn} border-pen/30 bg-pen text-white hover:bg-pen`}>
            {busy === "run" ? "Erzeuge…" : "Jetzt Rechnung erzeugen"}
          </button>
        )}
        {status === "ACTIVE" && (
          <button onClick={() => setStatus("PAUSED")} disabled={busy !== null} className={`${btn} border-seal/30 bg-sheet text-seal hover:bg-seal/10`}>
            Pausieren
          </button>
        )}
        {status === "PAUSED" && (
          <button onClick={() => setStatus("ACTIVE")} disabled={busy !== null} className={`${btn} border-ledger/30 bg-sheet text-ledger hover:bg-ledger/10`}>
            Fortsetzen
          </button>
        )}
        {status !== "ENDED" && (
          <button onClick={() => setStatus("ENDED")} disabled={busy !== null} className={`${btn} border-rule-strong bg-sheet text-ink-soft hover:bg-paper`}>
            Beenden
          </button>
        )}
      </div>
      {info && <p className="text-xs text-ledger">{info}</p>}
      {error && <p className="text-xs text-stamp">{error}</p>}
    </div>
  );
}
