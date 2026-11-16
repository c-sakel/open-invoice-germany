"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateIncomingAction } from "@/app/eingang/actions";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import { parseDecimalInput } from "@/lib/money";
import { formatIncomingMoney, formatIsoDay } from "./incoming-ui";

export interface ManualView {
  supplierName: string;
  number: string;
  issueDate: string;
  grossCents: number;
  currency: string;
  dueDate?: string;
}

interface Props {
  id: string;
  manual: ManualView | null;
  /** Nur in Neu und Geprüft änderbar. */
  editable: boolean;
}

/** Kopfdaten von Hand für Dateien ohne lesbare Nummer und Betrag (PDF/Bild). Sie sind immer als "von Hand" gekennzeichnet. */
export function IncomingManualHeader({ id, manual, editable }: Props) {
  const router = useRouter();
  const [supplierName, setSupplierName] = useState(manual?.supplierName ?? "");
  const [number, setNumber] = useState(manual?.number ?? "");
  const [issueDate, setIssueDate] = useState(manual?.issueDate ?? "");
  const [gross, setGross] = useState(manual ? (manual.grossCents / 100).toFixed(2).replace(".", ",") : "");
  const [currency, setCurrency] = useState(manual?.currency ?? "EUR");
  const [dueDate, setDueDate] = useState(manual?.dueDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(value: unknown) {
    setBusy(true);
    setError(null);
    try {
      const r = await updateIncomingAction(id, { manual: value });
      if (!r.ok) setError(r.error);
      else router.refresh();
    } catch {
      setError("Die Kopfdaten konnten nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const cents = parseDecimalInput(gross, 2);
    if (cents === null || cents < 0) {
      setError("Bitte den Bruttobetrag als Zahl angeben, z. B. 119,00.");
      return;
    }
    void send({ supplierName, number, issueDate, grossCents: cents, currency: currency.trim().toUpperCase(), ...(dueDate !== "" ? { dueDate } : {}) });
  }

  return (
    <section aria-label="Kopfdaten von Hand" className="space-y-3 rounded-md border border-rule bg-paper p-4 text-sm">
      <h2 className="text-base font-medium text-ink">Kopfdaten von Hand</h2>
      <p className="text-xs text-ink-muted">Die Datei liefert keine lesbaren Angaben. Die hier erfassten Werte sind von Hand eingetragen und werden so gekennzeichnet; die Originaldatei bleibt unverändert.</p>
      {!editable ? (
        <div className="space-y-1 text-ink-soft">
          <p className="text-xs text-ink-muted">Gesperrt — zuerst zurücksetzen.</p>
          {manual ? (
            <p className="break-words">
              {manual.supplierName} · Nr. {manual.number} · {formatIsoDay(manual.issueDate)} · {formatIncomingMoney(manual.grossCents, manual.currency)}
              {manual.dueDate ? ` · fällig ${formatIsoDay(manual.dueDate)}` : ""} <span className="text-ink-muted">(von Hand)</span>
            </p>
          ) : (
            <p>Keine Angaben erfasst.</p>
          )}
        </div>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-medium text-ink-soft">Lieferant</span>
            <input className={inputCls} required maxLength={200} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Rechnungsnummer</span>
            <input className={inputCls} required maxLength={100} value={number} onChange={(e) => setNumber(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Rechnungsdatum</span>
            <input type="date" className={inputCls} required value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Bruttobetrag</span>
            <input className={inputCls} required inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Währung</span>
            <input className={inputCls} required maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Fällig am (optional)</span>
            <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
            <Button variant="primary" type="submit" disabled={busy}>
              Kopfdaten speichern
            </Button>
            {manual ? (
              <Button variant="quiet" disabled={busy} onClick={() => void send(null)}>
                Angaben zurücknehmen
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <p role="alert" className={error ? "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900" : "sr-only"}>
        {error}
      </p>
    </section>
  );
}
