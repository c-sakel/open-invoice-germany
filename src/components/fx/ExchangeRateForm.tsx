"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { refreshExchangeRatesAction, upsertExchangeRateAction } from "@/app/actions/exchange-rate";
import type { ActionResult } from "@/app/actions/result";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { SelectField, TextField, ErrorBanner, SubmitButton } from "@/components/forms/fields";

/** Formular "Monatskurs pflegen" (auch Tageskurs): Quelle, Waehrung, Datum, Kurs, Notiz. */
export function ManualRateForm() {
  const [state, action] = useActionState<ActionResult, FormData>(upsertExchangeRateAction, { ok: false });
  return (
    <form action={action} className="space-y-4">
      <ErrorBanner message={state.error} />
      {state.ok && state.message && <p className="text-sm text-ledger">{state.message}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label="Art"
          name="source"
          defaultValue="MONTHLY"
          options={[
            { value: "MONTHLY", label: "Monatsdurchschnitt" },
            { value: "ECB", label: "Tageskurs (EZB)" },
          ]}
        />
        <TextField label="Währung" name="currency" placeholder="USD" defaultValue="" />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Datum</span>
          <input
            type="date"
            name="rateDate"
            required
            className="rounded-[var(--radius-control)] border border-rule-strong bg-sheet px-3 py-2 text-sm"
          />
          <span className="text-xs text-ink-muted">Beim Monatsdurchschnitt zählt der Monat des Datums.</span>
        </label>
        <TextField label="Kurs (je 1 EUR)" name="rate" placeholder="1,1214" defaultValue="" hint="Einheiten der Fremdwährung, höchstens 6 Nachkommastellen." />
      </div>
      <TextField label="Notiz (optional)" name="note" defaultValue="" placeholder="z. B. amtlicher Monatswert des BMF" />
      <SubmitButton>Kurs speichern</SubmitButton>
    </form>
  );
}

/** Button "Jetzt abrufen" mit Bestaetigung (der Abruf wirkt auf die instanzweite Kurstabelle). */
export function RefreshRatesButton({ disabled }: { disabled: boolean }) {
  const dialog = useRef<ConfirmDialogHandle>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="space-y-2">
      <Button variant="secondary" disabled={disabled || pending} onClick={() => dialog.current?.open()}>
        {pending ? "Abruf läuft…" : "Jetzt abrufen"}
      </Button>
      {disabled && <p className="text-xs text-ink-muted">Der automatische Abruf ist abgeschaltet (FX_AUTO_FETCH=0).</p>}
      {result?.ok && <p className="text-sm text-ledger">{result.message}</p>}
      {result && !result.ok && (
        <p role="alert" className="text-sm text-stamp">
          {result.error}
        </p>
      )}
      <ConfirmDialog
        ref={dialog}
        title="EZB-Kurse jetzt abrufen?"
        message="Die Referenzkurse der Europäischen Zentralbank werden abgerufen und die fehlenden Tageskurse sowie das Monatsmittel des Vormonats gespeichert. Gepflegte Kurse bleiben unverändert."
        confirmLabel="Jetzt abrufen"
        onConfirm={() => startTransition(async () => setResult(await refreshExchangeRatesAction()))}
      />
    </div>
  );
}
