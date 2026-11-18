"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelBankSetupAction, connectBankAction, continueBankSetupAction, selectBankAccountsAction } from "@/app/einstellungen/kontoabruf/actions";
import type { PublicChallenge } from "@/domain/bank-fetch/setup";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { BankConnectionClientView, SetupUi } from "./bank-fetch-core";
import {
  BANK_UNLOCK_CONFIRM_TEXT,
  isOpticalChipTan,
  needsUnlockConfirm,
  NO_CAMT_TEXT,
  OPTICAL_CHIPTAN_HINT,
  SECRET_FIELD_HINT,
  sortTanMethods,
  UNLOCK_CONFIRM_TEXT,
  type TanMethodOption,
} from "./bank-fetch-ui";
import { BankFetchPanel } from "./BankFetchPanel";
import { ScaDialog } from "./ScaDialog";

type Step = "login" | "method" | "sca" | "accounts" | "fetch";

/** Auswahl des Zwei-Schritt-Verfahrens: Freigabe in der App zuerst, optische chipTAN nicht wählbar. */
export function TanMethodChooser({ methods, selected, onSelect, disabled }: { methods: TanMethodOption[]; selected: number | null; onSelect: (id: number) => void; disabled?: boolean }) {
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-ink-soft">TAN-Verfahren</legend>
      {sortTanMethods(methods).map((m) => {
        const optical = !m.decoupled && isOpticalChipTan(m.name);
        return (
          <label key={m.id} className={`flex items-start gap-2 ${optical ? "text-ink-muted" : ""}`}>
            <input type="radio" name="tanMethod" className="mt-1" disabled={optical || disabled} checked={selected === m.id} onChange={() => onSelect(m.id)} />
            <span>
              {m.name}
              {m.decoupled ? <span className="ml-2 rounded bg-ledger/10 px-1.5 py-0.5 text-xs text-ledger">Freigabe in der App</span> : null}
              {optical ? <span className="block text-xs">{OPTICAL_CHIPTAN_HINT}</span> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Auswahl der Konten: nur Konten mit CAMT-Abruf sind wählbar. */
export function AccountPicker({ accounts, selected, onToggle, disabled }: { accounts: BankConnectionClientView["accounts"]; selected: ReadonlySet<string>; onToggle: (id: string) => void; disabled?: boolean }) {
  if (accounts.length === 0) return <p className="text-ink-muted">Die Bank hat keine Konten gemeldet.</p>;
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-ink-soft">Konten für den Abruf</legend>
      {accounts.map((a) => (
        <label key={a.id} className={`flex items-start gap-2 ${a.camtSupported ? "" : "text-ink-muted"}`}>
          <input type="checkbox" className="mt-1 h-4 w-4" disabled={!a.camtSupported || disabled} checked={a.camtSupported && selected.has(a.id)} onChange={() => onToggle(a.id)} />
          <span>
            <span className="font-mono text-xs">{a.ibanMasked}</span>
            {a.productName ? ` · ${a.productName}` : ""}
            {a.currency ? ` · ${a.currency}` : ""}
            {!a.camtSupported ? <span className="block text-xs">{NO_CAMT_TEXT}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Einrichtung eines Bankzugangs: Anmelden, bei Bedarf TAN-Verfahren wählen, freigeben, Konten wählen, erster Abruf.
 * Die PIN bleibt nur im Speicher dieser Seite, bis die Konten gelesen sind, und wird dann verworfen.
 */
export function BankSetupWizard({ connection, onClose }: { connection: BankConnectionClientView; onClose: () => void }) {
  const router = useRouter();
  const [conn, setConn] = useState(connection);
  const [step, setStep] = useState<Step>("login");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState(false);
  const [confirmBank, setConfirmBank] = useState(false);
  const [methods, setMethods] = useState<TanMethodOption[]>([]);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [sca, setSca] = useState<{ token: string; challenge: PublicChallenge } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = needsUnlockConfirm(conn.state, conn.lastErrorCode);
  const stored = conn.pinMode === "STORED" && conn.hasPin;
  const unlockOk = unlock === "NONE" || (unlock === "PIN" ? confirmPin : confirmBank);

  function handle(data: SetupUi) {
    if (data.state === "SCA") {
      setSca({ token: data.token, challenge: data.challenge });
      setStep("sca");
    } else if (data.state === "CHOOSE_TAN_METHOD") {
      setSca(null);
      setMethods(data.methods);
      setStep("method");
    } else {
      setSca(null);
      setConn(data.connection);
      setSelected(new Set(data.connection.accounts.filter((a) => a.camtSupported && (a.selected || !data.connection.accounts.some((x) => x.selected))).map((a) => a.id)));
      setPin("");
      setStep("accounts");
      router.refresh();
    }
  }

  function flags() {
    return {
      ...(unlock === "PIN" && confirmPin ? { unlockConfirmed: true } : {}),
      ...(unlock === "BANK" && confirmBank ? { bankUnlockConfirmed: true } : {}),
    };
  }

  async function connect(tanMethod?: TanMethodOption) {
    setBusy(true);
    setError(null);
    const r = await connectBankAction(conn.id, {
      ...(stored ? {} : { pin }),
      ...(tanMethod ? { tanMethodId: tanMethod.id, ...(tanMethod.media[0] ? { tanMediaName: tanMethod.media[0] } : {}) } : {}),
      ...flags(),
    });
    setBusy(false);
    if (!r.ok) {
      setPin("");
      setError(r.error);
      setStep("login");
      return;
    }
    handle(r.data);
  }

  async function proceed(tan?: string) {
    if (!sca) return;
    setBusy(true);
    const r = await continueBankSetupAction(sca.token, tan === undefined ? {} : { tan });
    setBusy(false);
    if (!r.ok) {
      setSca(null);
      setPin("");
      setError(r.error);
      setStep("login");
      return;
    }
    handle(r.data);
  }

  async function cancel() {
    const token = sca?.token;
    setSca(null);
    setPin("");
    setStep("login");
    if (token) await cancelBankSetupAction(token);
    router.refresh();
  }

  async function saveAccounts() {
    setBusy(true);
    setError(null);
    const r = await selectBankAccountsAction(conn.id, { accountIds: [...selected] });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setConn(r.data);
    setStep("fetch");
    router.refresh();
  }

  return (
    <section aria-label="Einrichtung" className="space-y-4 rounded-md border border-rule bg-paper p-4 text-sm">
      <ErrorBanner message={error ?? undefined} />
      {step === "login" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && unlockOk && (stored || pin !== "")) void connect();
          }}
        >
          <p className="text-ink-soft">Der Zugang wird bei der Bank angemeldet und die Konten werden gelesen. Bei mehrfach falscher PIN sperrt die Bank den Zugang.</p>
          {stored ? (
            <p className="text-ink-muted">Es wird die gespeicherte PIN verwendet.</p>
          ) : (
            <label className="flex min-w-0 flex-col gap-1">
              <span className="font-medium text-ink-soft">PIN</span>
              <input className={`${inputCls} w-full min-w-0 sm:w-56`} type="password" autoComplete="off" maxLength={64} value={pin} onChange={(e) => setPin(e.target.value)} />
              <span className="text-xs text-ink-muted">{SECRET_FIELD_HINT}</span>
            </label>
          )}
          {unlock !== "NONE" ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={unlock === "PIN" ? confirmPin : confirmBank}
                onChange={(e) => (unlock === "PIN" ? setConfirmPin(e.target.checked) : setConfirmBank(e.target.checked))}
              />
              <span>{unlock === "BANK" ? BANK_UNLOCK_CONFIRM_TEXT : UNLOCK_CONFIRM_TEXT}</span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy || !unlockOk || (!stored && pin === "")}>
              {busy ? "Bitte warten …" : "Verbinden"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Schließen
            </Button>
          </div>
        </form>
      ) : null}
      {step === "method" ? (
        <div className="space-y-3">
          <TanMethodChooser methods={methods} selected={methodId} onSelect={setMethodId} disabled={busy} />
          <Button
            variant="primary"
            disabled={busy || methodId === null}
            onClick={() => {
              const m = methods.find((x) => x.id === methodId);
              if (m) void connect(m);
            }}
          >
            {busy ? "Bitte warten …" : "Mit diesem Verfahren anmelden"}
          </Button>
        </div>
      ) : null}
      {step === "sca" && sca ? <ScaDialog challenge={sca.challenge} busy={busy} onContinue={(t) => void proceed(t)} onCancel={() => void cancel()} /> : null}
      {step === "accounts" ? (
        <div className="space-y-3">
          <AccountPicker
            accounts={conn.accounts}
            selected={selected}
            disabled={busy}
            onToggle={(id) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))}
          />
          <Button variant="primary" disabled={busy || selected.size === 0} onClick={() => void saveAccounts()}>
            {busy ? "Bitte warten …" : "Konten übernehmen"}
          </Button>
        </div>
      ) : null}
      {step === "fetch" ? (
        <div className="space-y-3">
          <p className="font-medium text-ink">Bankzugang eingerichtet. Jetzt die Umsätze zum ersten Mal abrufen.</p>
          <BankFetchPanel connections={[conn]} />
          <Button variant="secondary" onClick={onClose}>
            Fertig
          </Button>
        </div>
      ) : null}
    </section>
  );
}
