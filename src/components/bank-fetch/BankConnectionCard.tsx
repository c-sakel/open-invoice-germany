"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { archiveBankConnectionAction, selectBankAccountsAction, setBankAutoAction, updateBankConnectionAction } from "@/app/einstellungen/kontoabruf/actions";
import { ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { BankConnectionClientView } from "./bank-fetch-core";
import {
  ARCHIVE_CONFIRM_TEXT,
  connectionStateText,
  connectionStateTone,
  connectionWarnings,
  formatDateTime,
  formatDay,
  maskedConnectionUser,
  NO_CAMT_TEXT,
  PIN_MODE_PER_FETCH,
  SCA_RENEW_HINT,
} from "./bank-fetch-ui";
import { BankConnectionForm } from "./BankConnectionForm";
import { BankFetchPanel } from "./BankFetchPanel";
import { AccountPicker, BankSetupWizard } from "./BankSetupWizard";
import { StoredPinForm } from "./StoredPinForm";

const TONE: Record<string, string> = {
  ok: "border-ledger/30 bg-ledger/10 text-ledger",
  warn: "border-seal/30 bg-seal/10 text-seal",
  neutral: "border-rule bg-paper text-ink-soft",
};

/** Schalter für den täglichen Abruf: nur bei gespeicherter PIN und Zustand "Bereit", sonst ein Hinweis. */
export function AutoFetchControl({ connection, busy, onToggle }: { connection: BankConnectionClientView; busy?: boolean; onToggle: (enabled: boolean) => void }) {
  const eligible = connection.pinMode === "STORED" && connection.hasPin && connection.state === "READY";
  if (!eligible) {
    return <p className="text-xs text-ink-muted">Der tägliche automatische Abruf ist möglich, wenn die PIN gespeichert ist und ein manueller Abruf erfolgreich war.</p>;
  }
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-1 h-4 w-4" checked={connection.autoEnabled} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
      <span>
        <span className="font-medium text-ink-soft">Täglich automatisch abrufen</span>
        {connection.scaRenewBy ? (
          <span className="block text-xs text-ink-muted">
            Freigabe spätestens erneuern bis {formatDay(connection.scaRenewBy)}. {SCA_RENEW_HINT}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function BankConnectionCard({ connection }: { connection: BankConnectionClientView }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "setup" | "fetch">("view");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(connection.accounts.filter((a) => a.selected).map((a) => a.id)));
  const warnings = connectionWarnings(connection);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? null);
    router.refresh();
    return r.ok;
  }

  return (
    <article aria-label={connection.label} className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-ink">{connection.label}</h3>
          <p className="text-xs text-ink-muted">
            BLZ {connection.bankCode} · Anmeldename {maskedConnectionUser(connection.userId)}
          </p>
        </div>
        <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${TONE[connectionStateTone(connection.state)]}`}>{connectionStateText(connection.state)}</span>
      </header>
      <ErrorBanner message={error ?? undefined} />
      {warnings.map((w) => (
        <p key={w} role="alert" className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-seal">
          {w}
        </p>
      ))}
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-muted">Letzter Versuch</dt>
        <dd>{formatDateTime(connection.lastAttemptAt)}</dd>
        <dt className="text-ink-muted">Letzter Erfolg</dt>
        <dd>{formatDateTime(connection.lastSuccessAt)}</dd>
        <dt className="text-ink-muted">PIN</dt>
        <dd>{connection.pinMode === "STORED" && connection.hasPin ? "gespeichert (verschlüsselt)" : "je Abruf"}</dd>
      </dl>
      {connection.accounts.length > 0 ? (
        <ul className="space-y-1" aria-label="Konten">
          {connection.accounts.map((a) => (
            <li key={a.id} className="text-ink-soft">
              <span className="font-mono text-xs">{a.ibanMasked}</span>
              {a.selected ? " · wird abgerufen" : ""}
              {a.lastFetchedTo ? ` · abgerufen bis ${formatDay(a.lastFetchedTo)}` : ""}
              {!a.camtSupported ? ` · ${NO_CAMT_TEXT}` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      <AutoFetchControl
        connection={connection}
        busy={busy}
        onToggle={(enabled) => void run(() => setBankAutoAction(connection.id, enabled))}
      />

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => setMode(mode === "setup" ? "view" : "setup")}>
          {connection.accounts.length === 0 ? "Einrichten" : "Neu verbinden"}
        </Button>
        <Button variant="secondary" disabled={busy || connection.accounts.length === 0} onClick={() => setMode(mode === "fetch" ? "view" : "fetch")}>
          Konten abrufen
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setMode(mode === "edit" ? "view" : "edit")}>
          Bearbeiten
        </Button>
        {confirmArchive ? null : (
          <Button variant="danger-quiet" disabled={busy} onClick={() => setConfirmArchive(true)}>
            Entfernen
          </Button>
        )}
      </div>

      {confirmArchive ? (
        <div role="alertdialog" aria-label="Bankzugang entfernen" className="space-y-2 rounded-md border border-stamp/30 bg-stamp/10 p-3">
          <p>{ARCHIVE_CONFIRM_TEXT}</p>
          <div className="flex gap-2">
            <Button variant="danger-quiet" disabled={busy} onClick={() => void run(() => archiveBankConnectionAction(connection.id))}>
              Ja, entfernen
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>
              Abbrechen
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "edit" ? <BankConnectionForm initial={connection} onSaved={() => setMode("view")} onCancel={() => setMode("view")} /> : null}
      {mode === "setup" ? <BankSetupWizard connection={connection} onClose={() => setMode("view")} /> : null}
      {mode === "fetch" ? <BankFetchPanel connections={[connection]} /> : null}

      <details className="rounded-md border border-rule p-3">
        <summary className="cursor-pointer font-medium text-ink-soft">PIN-Modus und Konten</summary>
        <div className="mt-3 space-y-4">
          {connection.pinMode === "STORED" && connection.hasPin ? (
            <div className="space-y-2">
              <p className="text-ink-muted">Die PIN ist verschlüsselt gespeichert. Zum Austauschen eine neue PIN eingeben:</p>
              <StoredPinForm connectionId={connection.id} state={connection.state} lastErrorCode={connection.lastErrorCode} onSaved={() => router.refresh()} onError={setError} />
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => updateBankConnectionAction(connection.id, { pinMode: "PER_FETCH" }))}>
                Zurück auf PIN je Abruf
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-ink-muted">{PIN_MODE_PER_FETCH}</p>
              <p className="font-medium text-ink-soft">PIN speichern</p>
              <StoredPinForm connectionId={connection.id} state={connection.state} lastErrorCode={connection.lastErrorCode} onSaved={() => router.refresh()} onError={setError} />
            </div>
          )}
          {connection.accounts.length > 0 ? (
            <div className="space-y-2">
              <AccountPicker
                accounts={connection.accounts}
                selected={selected}
                disabled={busy}
                onToggle={(id) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))}
              />
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => selectBankAccountsAction(connection.id, { accountIds: [...selected] }))}>
                Auswahl speichern
              </Button>
            </div>
          ) : null}
        </div>
      </details>
    </article>
  );
}
