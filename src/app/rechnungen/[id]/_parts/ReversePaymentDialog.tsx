"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RowPaymentDialog } from "@/components/list/RowPaymentDialog";
import { formatCents, parseDecimalInput } from "@/lib/money";

/**
 * Zahlung korrigieren (Phase 16a, GoBD): bucht eine Gegenbuchung ueber
 * POST /api/invoices/[id]/payment/[pid]/reverse (-> reversePayment). Die Zahlung selbst
 * bleibt unveraendert sichtbar. Betrag im deutschen Format (parseDecimalInput), vorbelegt
 * mit dem noch nicht gegengebuchten Rest; Grund ist Pflicht.
 */
export function ReversePaymentDialog({
  invoiceId,
  paymentId,
  restCents,
  currency,
}: {
  invoiceId: string;
  paymentId: string;
  restCents: number;
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => (restCents / 100).toFixed(2).replace(".", ","));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    // Rest kann sich durch frueher gebuchte Teilkorrekturen geaendert haben.
    setAmount((restCents / 100).toFixed(2).replace(".", ","));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = parseDecimalInput(amount, 2);
    if (cents === null || cents <= 0) {
      setError("Betrag nicht lesbar – bitte z. B. 1.234,56 eingeben (höchstens 2 Nachkommastellen).");
      return;
    }
    if (cents > restCents) {
      setError(`Der Betrag darf höchstens ${formatCents(restCents, currency)} betragen.`);
      return;
    }
    if (reason.trim().length < 3) {
      setError("Bitte einen Grund mit mindestens 3 Zeichen angeben.");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/invoices/${invoiceId}/payment/${paymentId}/reverse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: cents, reason: reason.trim() }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Fehler");
      setBusy(false);
      return;
    }
    setBusy(false);
    setReason("");
    close();
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={openDialog} className="text-xs text-pen hover:underline">
        Korrigieren
      </button>
      <RowPaymentDialog open={open} onClose={close} title="Zahlung korrigieren">
        <form onSubmit={submit} className="space-y-3 text-sm">
          <p className="text-ink-muted">
            Gegenbuchung: Die Zahlung bleibt sichtbar, es wird eine negative Zahlungszeile ergänzt. Noch nicht korrigiert: {formatCents(restCents, currency)}.
          </p>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Betrag (€)</span>
            <input className="w-32 rounded-md border border-rule-strong px-3 py-2" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Grund (Pflicht)</span>
            <textarea
              className="rounded-md border border-rule-strong px-3 py-2"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </label>
          {error && <p className="text-stamp">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-md bg-pen px-3 py-1.5 font-medium text-white hover:bg-pen disabled:opacity-50">
              {busy ? "Buche…" : "Gegenbuchung erfassen"}
            </button>
            <button type="button" onClick={close} className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-ink-soft hover:bg-paper">
              Abbrechen
            </button>
          </div>
        </form>
      </RowPaymentDialog>
    </>
  );
}
