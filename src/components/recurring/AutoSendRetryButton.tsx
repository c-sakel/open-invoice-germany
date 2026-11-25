"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RowPaymentDialog } from "@/components/list/RowPaymentDialog";
import { retryAutoSendAction } from "@/app/rechnungen/[id]/auto-send-actions";

/**
 * "Erneut versuchen" fuer den automatischen Versand einer Abo-Rechnung (Belegansicht).
 * Bei unklarem Ausgang (`UNCLEAR`) erst nach ausdruecklicher Bestaetigung: die E-Mail kann doppelt ankommen.
 * Die Server-Action nutzt dieselbe Domainfunktion wie REST und MCP; der Doppelklick-Schutz liegt im Button (busy).
 */
export function AutoSendRetryButton({ invoiceId, status }: { invoiceId: string; status: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unclear = status === "UNCLEAR";

  async function run(confirmUnclear: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await retryAutoSendAction({ invoiceId, confirmUnclear });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Die Aktion konnte nicht ausgeführt werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => (unclear ? (setError(null), setOpen(true)) : void run(false))}
        className="rounded-md border border-rule-strong bg-sheet px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper disabled:opacity-50"
      >
        Erneut versuchen
      </button>
      {!unclear && error && (
        <span role="alert" className="block text-xs text-stamp">
          {error}
        </span>
      )}
      {unclear && (
        <RowPaymentDialog
          open={open}
          onClose={() => {
            setOpen(false);
            setError(null);
          }}
          title="Versand erneut versuchen"
        >
          <div className="space-y-3 text-sm">
            <p className="text-ink-muted">
              Der Ausgang des letzten Versands ist unklar. Prüfen Sie zuerst das E-Mail-Protokoll: Wurde die Rechnung bereits zugestellt, kommt sie durch einen
              neuen Versuch doppelt beim Kunden an.
            </p>
            {error && (
              <p role="alert" className="text-stamp">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(true)}
                className="rounded-md bg-pen px-3 py-1.5 font-medium text-on-accent hover:bg-pen-strong disabled:opacity-50"
              >
                {busy ? "Sende…" : "Trotzdem erneut senden"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-ink-soft hover:bg-paper"
              >
                Abbrechen
              </button>
            </div>
          </div>
        </RowPaymentDialog>
      )}
    </>
  );
}
