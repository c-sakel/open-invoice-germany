"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, parseDecimalInput } from "@/lib/money";

interface SkontoSuggestion {
  permille: number;
  days: number;
  dueDate: string;
  amountCents: number;
  payableCents: number;
  restCents: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface PaymentMethodOption {
  code: string;
  name: string;
}

export function PaymentForm({
  invoiceId,
  openCents,
  methods,
  defaultMethod,
  onDone,
}: {
  invoiceId: string;
  openCents: number;
  /** Aktive Zahlungsmethoden der Organisation OHNE den Systemcode SKONTO. */
  methods: PaymentMethodOption[];
  /** Vorbelegung: Kunden-Standard -> Methode der Rechnung -> "TRANSFER" (siehe Aufrufer). */
  defaultMethod: string;
  /** Phase 13c, Task 3: optionaler Rueckruf NACH erfolgreicher Buchung (router.refresh()) —
   *  damit sich ein umschliessender Dialog (PaymentDialog) schliessen kann. Kein neuer
   *  Schreibpfad, PaymentForm bucht weiterhin unveraendert selbst. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState((openCents / 100).toFixed(2));
  const [paidAt, setPaidAt] = useState(todayIso());
  const [method, setMethod] = useState(defaultMethod);
  // Phase 8b (§42): Referenz/Notiz zur Zahlung (recordPaymentSchema.reference/note, Task 1).
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [applySkonto, setApplySkonto] = useState(false);
  const [suggestion, setSuggestion] = useState<SkontoSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Vorschau der Skontofrist bei jeder Aenderung von Betrag/Datum — kein Schreibvorgang,
  // GET /api/invoices/[id]/skonto-check. Debounce vermeidet eine Anfrage pro Tastenanschlag.
  useEffect(() => {
    const cents = parseDecimalInput(amount, 2) ?? 0;
    const t = setTimeout(async () => {
      if (cents <= 0) {
        setSuggestion(null);
        return;
      }
      try {
        const params = new URLSearchParams({ amountCents: String(cents) });
        if (paidAt) params.set("paidAt", paidAt);
        const res = await fetch(`/api/invoices/${invoiceId}/skonto-check?${params.toString()}`);
        if (!res.ok) {
          setSuggestion(null);
          return;
        }
        const j = (await res.json()) as { suggestion: SkontoSuggestion | null };
        setSuggestion(j.suggestion);
        if (!j.suggestion) setApplySkonto(false);
      } catch {
        setSuggestion(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [amount, paidAt, invoiceId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const cents = parseDecimalInput(amount, 2);
    if (cents === null || cents <= 0) {
      setError("Betrag nicht lesbar – bitte z. B. 1.234,56 oder 1234.56 eingeben (höchstens 2 Nachkommastellen).");
      setBusy(false);
      return;
    }
    const res = await fetch(`/api/invoices/${invoiceId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountCents: cents,
        paidAt: paidAt || undefined,
        method,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
        applySkonto: suggestion ? applySkonto : false,
      }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Fehler");
      setBusy(false);
      return;
    }
    router.refresh();
    onDone?.();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Zahlung erfassen (€)</span>
          <span className="flex items-center gap-1">
            <input className="w-28 rounded-md border border-rule-strong px-3 py-2 text-sm" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {/* Phase 8b (§42): "Restbetrag uebernehmen" — setzt den vollen offenen Betrag,
                falls der Nutzer vorher einen anderen Wert eingetragen hatte. */}
            <button
              type="button"
              onClick={() => setAmount((openCents / 100).toFixed(2))}
              className="rounded-md border border-rule-strong bg-sheet px-2 py-2 text-xs font-medium text-ink-soft hover:bg-paper"
              title="Restbetrag übernehmen"
            >
              Rest
            </button>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Zahlungsdatum</span>
          <input type="date" className="rounded-md border border-rule-strong px-3 py-2 text-sm" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Zahlungsart</span>
          <select className="rounded-md border border-rule-strong px-3 py-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((m) => (
              <option key={m.code} value={m.code}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Referenz</span>
          <input
            className="w-32 rounded-md border border-rule-strong px-3 py-2 text-sm"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="z. B. Belegnr."
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Notiz</span>
          <input
            className="w-40 rounded-md border border-rule-strong px-3 py-2 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="z. B. per Scheck"
          />
        </label>
        <button type="submit" disabled={busy} className="rounded-md bg-ledger px-3 py-2 text-sm font-medium text-white hover:bg-ledger disabled:opacity-60">
          {busy ? "…" : "Buchen"}
        </button>
        {error && <span className="text-xs text-stamp">{error}</span>}
      </div>

      {suggestion && (
        <label className="flex items-start gap-2 rounded-md border border-ledger/30 bg-ledger/10 p-2 text-xs text-ledger">
          <input type="checkbox" className="mt-0.5 h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" checked={applySkonto} onChange={(e) => setApplySkonto(e.target.checked)} />
          <span>
            {(suggestion.permille / 10).toString().replace(".", ",")} % Skonto möglich (Frist {new Intl.DateTimeFormat("de-DE").format(new Date(suggestion.dueDate))}). Rest{" "}
            {formatCents(suggestion.restCents)} als Skonto verbuchen?
          </span>
        </label>
      )}
    </form>
  );
}
