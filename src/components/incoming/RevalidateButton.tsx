"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { revalidateIncomingAction } from "@/app/eingang/actions";
import { validationLabel } from "./incoming-ui";

/** Prüfung erneut anstoßen; das Ergebnis erscheint als neue, unveränderliche Zeile. */
export function RevalidateButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await revalidateIncomingAction(id);
      if (!r.ok) setMessage(r.error);
      else {
        setMessage(r.data.validationId === null ? "Es gibt nichts zu prüfen (keine vollständige E-Rechnung)." : `Ergebnis: ${validationLabel(r.data.result)}.`);
        router.refresh();
      }
    } catch {
      setMessage("Die Prüfung konnte nicht ausgeführt werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-50"
      >
        {busy ? "Prüfung läuft …" : "Erneut prüfen"}
      </button>
      <span aria-live="polite" className="text-ink-muted">
        {message}
      </span>
    </div>
  );
}
