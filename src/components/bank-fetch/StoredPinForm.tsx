"use client";

import { useState } from "react";
import { storeBankPinAction } from "@/app/einstellungen/kontoabruf/actions";
import { inputCls } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import { BANK_UNLOCK_CONFIRM_TEXT, needsUnlockConfirm, PIN_STORE_CONFIRM_TEXT, SECRET_FIELD_HINT, UNLOCK_CONFIRM_TEXT } from "./bank-fetch-ui";

export interface PinFieldsState {
  pin: string;
  confirm: boolean;
}

/** PIN-Feld mit Pflicht-Haken für die verschlüsselte Speicherung. Nie vorbefüllt. */
export function StoredPinFields({ value, onChange, disabled }: { value: PinFieldsState; onChange: (v: PinFieldsState) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      <label className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-ink-soft">PIN</span>
        <input
          className={`${inputCls} w-full min-w-0 sm:w-56`}
          type="password"
          name="pin"
          autoComplete="off"
          maxLength={64}
          value={value.pin}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, pin: e.target.value })}
        />
        <span className="text-xs text-ink-muted">{SECRET_FIELD_HINT}</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirm" className="mt-1 h-4 w-4" checked={value.confirm} disabled={disabled} onChange={(e) => onChange({ ...value, confirm: e.target.checked })} />
        <span>{PIN_STORE_CONFIRM_TEXT}</span>
      </label>
    </div>
  );
}

/** PIN speichern (nur mit Bestätigung). Ein abgelehnter oder gesperrter Zugang braucht zusätzlich die ausdrückliche Freigabe. */
export function StoredPinForm({ connectionId, state, lastErrorCode, onSaved, onError }: { connectionId: string; state: string; lastErrorCode: string | null; onSaved: () => void; onError: (m: string) => void }) {
  const [fields, setFields] = useState<PinFieldsState>({ pin: "", confirm: false });
  const [unlockOk, setUnlockOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const unlock = needsUnlockConfirm(state, lastErrorCode);
  const ready = fields.pin !== "" && fields.confirm && (unlock === "NONE" || unlockOk) && !busy;

  async function save() {
    const payload = {
      pin: fields.pin,
      confirm: true as const,
      ...(unlock === "PIN" && unlockOk ? { unlockConfirmed: true } : {}),
      ...(unlock === "BANK" && unlockOk ? { bankUnlockConfirmed: true } : {}),
    };
    setBusy(true);
    setFields({ pin: "", confirm: false });
    setUnlockOk(false);
    const r = await storeBankPinAction(connectionId, payload);
    setBusy(false);
    if (!r.ok) onError(r.error);
    else onSaved();
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
    >
      <StoredPinFields value={fields} onChange={setFields} disabled={busy} />
      {unlock !== "NONE" ? (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={unlockOk} onChange={(e) => setUnlockOk(e.target.checked)} />
          <span>{unlock === "BANK" ? BANK_UNLOCK_CONFIRM_TEXT : UNLOCK_CONFIRM_TEXT}</span>
        </label>
      ) : null}
      <Button type="submit" variant="primary" disabled={!ready}>
        PIN speichern
      </Button>
    </form>
  );
}
