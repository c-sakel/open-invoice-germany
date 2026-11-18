"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelBankFetchAction, continueBankFetchAction, startBankFetchAction } from "@/app/bankabgleich/fetch-actions";
import type { RunSummary } from "@/domain/bank-fetch/run-types";
import type { PublicChallenge } from "@/domain/bank-fetch/setup";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { BankConnectionClientView } from "./bank-fetch-core";
import { BANK_UNLOCK_CONFIRM_TEXT, needsUnlockConfirm, SECRET_FIELD_HINT, UNLOCK_CONFIRM_TEXT } from "./bank-fetch-ui";
import { FetchRunSummaryList } from "./BankFetchRunTable";
import { ScaDialog } from "./ScaDialog";

interface Props {
  connections: BankConnectionClientView[];
  /** Nur zum Einrichten: PIN, die der Nutzer eben eingegeben hat (nur im Speicher dieser Seite). */
  carriedPin?: string;
  onDone?: (runs: RunSummary[]) => void;
}

/** Manueller Abruf mit Freigabe. Die PIN (nur bei "PIN je Abruf") wird nach dem Absenden aus dem Feld entfernt. */
export function BankFetchPanel({ connections, carriedPin = "", onDone }: Props) {
  const router = useRouter();
  const first = connections[0];
  const [connectionId, setConnectionId] = useState(first?.id ?? "");
  const [pin, setPin] = useState(carriedPin);
  const [from, setFrom] = useState("");
  const [confirmPin, setConfirmPin] = useState(false);
  const [confirmBank, setConfirmBank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sca, setSca] = useState<{ token: string; challenge: PublicChallenge } | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  const conn = connections.find((c) => c.id === connectionId) ?? first;
  if (!conn) return null;
  const selectable = conn.accounts.some((a) => a.selected && a.camtSupported);
  const perFetch = conn.pinMode !== "STORED" || !conn.hasPin;
  const unlock = needsUnlockConfirm(conn.state, conn.lastErrorCode);

  function handle(r: Awaited<ReturnType<typeof startBankFetchAction>>) {
    if (!r.ok) {
      setSca(null);
      setError(r.error);
      return;
    }
    if (r.data.state === "SCA") {
      setSca({ token: r.data.token, challenge: r.data.challenge });
      return;
    }
    setSca(null);
    setRuns(r.data.runs);
    onDone?.(r.data.runs);
    router.refresh();
  }

  async function start() {
    if (!conn) return;
    setBusy(true);
    setError(null);
    setRuns(null);
    const payload = {
      ...(perFetch ? { pin } : {}),
      ...(from !== "" ? { from } : {}),
      ...(unlock === "PIN" && confirmPin ? { unlockConfirmed: true } : {}),
      ...(unlock === "BANK" && confirmBank ? { bankUnlockConfirmed: true } : {}),
    };
    setPin("");
    handle(await startBankFetchAction(conn.id, payload));
    setBusy(false);
  }

  async function proceed(tan?: string) {
    if (!sca) return;
    setBusy(true);
    handle(await continueBankFetchAction(sca.token, tan === undefined ? {} : { tan }));
    setBusy(false);
  }

  async function cancel() {
    if (!sca) return;
    const token = sca.token;
    setSca(null);
    await cancelBankFetchAction(token);
    router.refresh();
  }

  const unlockOk = unlock === "NONE" || (unlock === "PIN" ? confirmPin : confirmBank);
  const canStart = !busy && selectable && unlockOk && (!perFetch || pin !== "");

  return (
    <section aria-label="Konten abrufen" className="space-y-3 text-sm">
      <ErrorBanner message={error ?? undefined} />
      {connections.length > 1 ? (
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-ink-soft">Bankzugang</span>
          <select className={`${inputCls} w-full min-w-0 sm:w-80`} value={conn.id} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!selectable ? <p className="text-ink-muted">Bitte zuerst in den Einstellungen mindestens ein Konto mit Umsatzabruf auswählen.</p> : null}
      {sca ? (
        <ScaDialog challenge={sca.challenge} busy={busy} onContinue={(t) => void proceed(t)} onCancel={() => void cancel()} />
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canStart) void start();
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            {perFetch ? (
              <label className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-ink-soft">PIN</span>
                <input className={`${inputCls} w-full min-w-0 sm:w-56`} type="password" autoComplete="off" maxLength={64} value={pin} onChange={(e) => setPin(e.target.value)} />
                <span className="text-xs text-ink-muted">{SECRET_FIELD_HINT}</span>
              </label>
            ) : (
              <p className="text-ink-muted">Es wird die gespeicherte PIN verwendet.</p>
            )}
            <label className="flex min-w-0 flex-col gap-1">
              <span className="font-medium text-ink-soft">Ab Datum (optional)</span>
              <input className={`${inputCls} w-full min-w-0 sm:w-44`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
          </div>
          {unlock === "PIN" ? (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={confirmPin} onChange={(e) => setConfirmPin(e.target.checked)} />
              <span>{UNLOCK_CONFIRM_TEXT}</span>
            </label>
          ) : null}
          {unlock === "BANK" ? (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={confirmBank} onChange={(e) => setConfirmBank(e.target.checked)} />
              <span>{BANK_UNLOCK_CONFIRM_TEXT}</span>
            </label>
          ) : null}
          <Button type="submit" variant="primary" disabled={!canStart}>
            {busy ? "Bitte warten …" : "Jetzt abrufen"}
          </Button>
        </form>
      )}
      {runs ? <FetchRunSummaryList runs={runs} /> : null}
    </section>
  );
}
