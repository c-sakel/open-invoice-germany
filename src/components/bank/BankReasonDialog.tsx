"use client";

import { useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";

interface Props {
  triggerLabel: string;
  title: string;
  message: ReactNode;
  fieldLabel: string;
  confirmLabel: string;
  /** Mindestlaenge des Grundes; 0 = Grund optional. */
  minLength: number;
  tone?: "default" | "danger";
  /** Weitere Felder oberhalb des Grundes (z. B. Auswahl der Zahlung). */
  extra?: ReactNode;
  canSubmit?: boolean;
  /** `null` = erfolgreich, Dialog schliesst; sonst bleibt er mit dieser Fehlermeldung offen. */
  onSubmit: (reason: string) => Promise<string | null>;
}

/** Knopf mit Bestaetigungsdialog und Begruendungsfeld (Ignorieren, Erledigen, Zuruecknehmen, Gegenbuchen). */
export function BankReasonDialog({ triggerLabel, title, message, fieldLabel, confirmLabel, minLength, tone = "default", extra, canSubmit = true, onSubmit }: Props) {
  const ref = useRef<ConfirmDialogHandle>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = canSubmit && reason.trim().length >= minLength;

  async function submit() {
    setBusy(true);
    try {
      const err = await onSubmit(reason.trim());
      setError(err);
      if (err === null) {
        setReason("");
        ref.current?.close();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => ref.current?.open()} className="text-sm font-medium text-pen underline hover:text-pen-strong">
        {triggerLabel}
      </button>
      <ConfirmDialog
        ref={ref}
        title={title}
        tone={tone}
        size="md"
        busy={busy}
        confirmDisabled={!valid}
        confirmLabel={confirmLabel}
        onConfirm={() => void submit()}
        message={
          <div className="space-y-3">
            <div>{message}</div>
            {extra}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-soft">
                {fieldLabel}
                {minLength === 0 ? " (optional)" : ""}
              </span>
              <textarea
                value={reason}
                maxLength={300}
                rows={2}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-md border border-rule-strong bg-paper px-2 py-1 text-sm"
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-stamp">
                {error}
              </p>
            )}
          </div>
        }
      />
    </>
  );
}
