"use client";

/** Offenen Verbrauchssatz stornieren: Rueckfrage mit Pflichtgrund; der Satz bleibt als storniert erhalten. */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";

export function VoidUsageButton({ recurringId, usageId, summary }: { recurringId: string; usageId: string; summary: string }) {
  const router = useRouter();
  const dialog = useRef<ConfirmDialogHandle>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/recurring/${recurringId}/usage/${usageId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() }),
    }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      const j = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setError(j.error ?? "Storno fehlgeschlagen.");
      return;
    }
    dialog.current?.close();
    setReason("");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => dialog.current?.open()} className="text-xs font-medium text-stamp hover:underline">
        Stornieren
      </button>
      <ConfirmDialog
        ref={dialog}
        tone="danger"
        title="Verbrauch stornieren?"
        confirmLabel="Stornieren"
        busy={busy}
        confirmDisabled={reason.trim() === ""}
        onConfirm={confirm}
        message={
          <div className="space-y-2">
            <p>{summary} wird nicht mehr abgerechnet. Der Satz bleibt mit Grund einsehbar.</p>
            <label className="block text-xs font-medium text-ink-soft">
              Grund (Pflicht)
              <textarea className="mt-1 w-full rounded-md border border-rule-strong px-2 py-1.5 text-sm" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div aria-live="polite" className="text-xs text-stamp">
              {error}
            </div>
          </div>
        }
      />
    </>
  );
}
