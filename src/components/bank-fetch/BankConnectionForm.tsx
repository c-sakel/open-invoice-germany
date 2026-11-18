"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBankConnectionAction, storeBankPinAction, updateBankConnectionAction } from "@/app/einstellungen/kontoabruf/actions";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { BankConnectionClientView } from "./bank-fetch-core";
import { PIN_MODE_PER_FETCH, URL_HINT } from "./bank-fetch-ui";
import { StoredPinFields, type PinFieldsState } from "./StoredPinForm";

/** Bankzugang anlegen oder ändern. Die PIN wird nur bei der Anlage mit "PIN speichern" und Bestätigung abgelegt. */
export function BankConnectionForm({ initial, onSaved, onCancel }: { initial?: BankConnectionClientView; onSaved?: () => void; onCancel?: () => void }) {
  const router = useRouter();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [bankCode, setBankCode] = useState(initial?.bankCode ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [userId, setUserId] = useState(initial?.userId ?? "");
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [pinMode, setPinMode] = useState<"PER_FETCH" | "STORED">("PER_FETCH");
  const [pinFields, setPinFields] = useState<PinFieldsState>({ pin: "", confirm: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storeOk = pinMode === "PER_FETCH" || (pinFields.pin !== "" && pinFields.confirm);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!storeOk) return;
    setBusy(true);
    setError(null);
    const base = { label, bankCode, url, userId, customerId: customerId.trim() === "" ? null : customerId.trim() };
    const r = initial ? await updateBankConnectionAction(initial.id, base) : await createBankConnectionAction(base);
    if (!r.ok) {
      setBusy(false);
      setError(r.error);
      return;
    }
    if (!initial && pinMode === "STORED") {
      const payload = { pin: pinFields.pin, confirm: true as const };
      setPinFields({ pin: "", confirm: false });
      const s = await storeBankPinAction(r.data.id, payload);
      if (!s.ok) setError(s.error);
    }
    setBusy(false);
    setPinFields({ pin: "", confirm: false });
    if (!initial) {
      setLabel("");
      setBankCode("");
      setUrl("");
      setUserId("");
      setCustomerId("");
      setPinMode("PER_FETCH");
    }
    onSaved?.();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-sm">
      <ErrorBanner message={error ?? undefined} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-ink-soft">Bezeichnung</span>
          <input className={`${inputCls} w-full min-w-0`} value={label} maxLength={60} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-ink-soft">Bankleitzahl (8 Ziffern)</span>
          <input className={`${inputCls} w-full min-w-0`} value={bankCode} maxLength={8} inputMode="numeric" autoComplete="off" onChange={(e) => setBankCode(e.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 sm:col-span-2">
          <span className="font-medium text-ink-soft">FinTS-Adresse der Bank</span>
          <input className={`${inputCls} w-full min-w-0`} value={url} maxLength={400} autoComplete="off" spellCheck={false} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
          <span className="text-xs text-ink-muted">{URL_HINT}</span>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-ink-soft">Anmeldename</span>
          <input className={`${inputCls} w-full min-w-0`} value={userId} maxLength={30} autoComplete="off" onChange={(e) => setUserId(e.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-ink-soft">Kunden-ID (optional)</span>
          <input className={`${inputCls} w-full min-w-0`} value={customerId} maxLength={30} autoComplete="off" onChange={(e) => setCustomerId(e.target.value)} />
        </label>
      </div>
      {initial ? (
        <p className="text-xs text-ink-muted">
          Wenn Bankleitzahl, Adresse, Anmeldename oder Kunden-ID geändert werden, wird die gespeicherte PIN gelöscht, der automatische Abruf beendet und die Einrichtung muss wiederholt werden.
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="font-medium text-ink-soft">PIN-Modus</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="pinMode" className="mt-1" checked={pinMode === "PER_FETCH"} onChange={() => setPinMode("PER_FETCH")} />
            <span>{PIN_MODE_PER_FETCH}</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="pinMode" className="mt-1" checked={pinMode === "STORED"} onChange={() => setPinMode("STORED")} />
            <span>PIN speichern (verschlüsselt, für den täglichen automatischen Abruf)</span>
          </label>
          {pinMode === "STORED" ? <StoredPinFields value={pinFields} onChange={setPinFields} disabled={busy} /> : null}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy || !storeOk}>
          {busy ? "Bitte warten …" : initial ? "Speichern" : "Bankzugang anlegen"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Abbrechen
          </Button>
        ) : null}
      </div>
    </form>
  );
}
