"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateIncomingAction } from "@/app/eingang/actions";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import { NOTE_HINT } from "./incoming-ui";

/** Interne Notiz zur Eingangsrechnung; sie steht in keinem Export, keiner Druckansicht und keiner Mail. */
export function IncomingNote({ id, initial }: { id: string; initial: string | null }) {
  const router = useRouter();
  const [text, setText] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await updateIncomingAction(id, { internalNote: text.trim() === "" ? null : text });
      setFailed(!r.ok);
      setMessage(r.ok ? "Gespeichert." : r.error);
      if (r.ok) router.refresh();
    } catch {
      setFailed(true);
      setMessage("Die Notiz konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Interne Notiz" className="space-y-2 rounded-md border border-rule bg-paper p-4 text-sm">
      <h2 className="text-base font-medium text-ink">Interne Notiz</h2>
      <p className="text-xs text-ink-muted">{NOTE_HINT}</p>
      <textarea className={`${inputCls} w-full`} rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Interne Notiz" />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={busy} onClick={() => void save()}>
          {busy ? "Speichern …" : "Notiz speichern"}
        </Button>
        <span role={failed ? "alert" : "status"} className={failed ? "text-red-900" : "text-ink-muted"}>
          {message}
        </span>
      </div>
    </section>
  );
}
