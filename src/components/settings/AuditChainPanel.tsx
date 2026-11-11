"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Kettenpruefung sofort starten (POST /api/settings/audit/chain), danach Seite neu laden. */
export function AuditChainPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/audit/chain", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { data?: { valid: boolean; entries: number }; error?: string };
      if (!res.ok || !j.data) {
        setMessage({ ok: false, text: j.error ?? "Prüfung fehlgeschlagen." });
      } else {
        setMessage(
          j.data.valid
            ? { ok: true, text: `Kette gültig (${j.data.entries} Einträge).` }
            : { ok: false, text: "Kette UNTERBROCHEN — siehe Benachrichtigungen." },
        );
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? "Prüfe …" : "Jetzt prüfen"}
      </button>
      {message && (
        <span role="status" className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
