"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelPostalJobAction, quotePostalAction, sendByPostAction } from "@/app/actions/postal";
import type { PostalQuoteDto } from "@/domain/postal/ui";
import type { PostalSendResult } from "@/domain/postal/send";
import { formatCents } from "@/lib/money";
import { MODE_LABEL, REGISTERED_LABEL, remainingLabel } from "./format";

type Reg = "default" | "none" | "r1" | "r2";

function regValue(r: Reg): "r1" | "r2" | null | undefined {
  return r === "default" ? undefined : r === "none" ? null : r;
}

/**
 * Per Post senden (Rechnung oder Mahnung): zeigt Anschrift, Seiten, Versandart, Kosten und Modus,
 * verlangt die Bestaetigung "Versand bestaetigen" und sendet nie von selbst. Probleme sperren das Absenden.
 */
export function SendByPostDialog({
  docType,
  docId,
  label = "Per Post senden",
  className,
}: {
  docType: "INVOICE" | "DUNNING";
  docId: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quote, setQuote] = useState<PostalQuoteDto | null>(null);
  const [reg, setReg] = useState<Reg>("default");
  const [confirmed, setConfirmed] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [result, setResult] = useState<PostalSendResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(nextReg: Reg) {
    setLoading(true);
    setLoadError(null);
    const res = await quotePostalAction({ items: [{ docType, docId, registered: regValue(nextReg) }] });
    setLoading(false);
    if (!res.ok) {
      setQuote(null);
      setLoadError(res.error);
      return;
    }
    setQuote(res.quotes[0] ?? null);
  }

  async function open() {
    setResult(null);
    setNotice(null);
    setConfirmed(false);
    setRepeat(false);
    setReg("default");
    setQuote(null);
    dialogRef.current?.showModal();
    await load("default");
  }

  function close() {
    dialogRef.current?.close();
    if (result && result.status !== "REJECTED") router.refresh();
  }

  async function cancelActive() {
    if (!quote?.activeJob) return;
    setBusy(true);
    setNotice(null);
    const res = await cancelPostalJobAction(quote.activeJob.id);
    setBusy(false);
    if (!res.ok) setNotice(res.error);
    else setNotice("Der Testauftrag wurde storniert.");
    await load(reg);
    router.refresh();
  }

  async function send() {
    if (!quote) return;
    setBusy(true);
    setNotice(null);
    const res = await sendByPostAction({
      items: [{ docType, docId, registered: regValue(reg), expectedPriceCents: quote.priceCents, pdfSha256: quote.pdfSha256, ...(repeat ? { repeat: true } : {}) }],
      confirm: confirmed ? true : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setNotice(res.error);
      return;
    }
    const r = res.results[0] ?? null;
    setResult(r);
    if (r?.status === "REJECTED") {
      setNotice(r.error ?? "Der Versand wurde abgelehnt.");
      setConfirmed(false);
      await load(reg); // frischer Stand (Preis, Prüfsumme, bestehender Auftrag)
    } else {
      router.refresh();
    }
  }

  const eff = quote?.effective ?? "OFF_DRY_RUN";
  const sending = eff === "TEST" || eff === "LIVE";
  const testBlocksLive = Boolean(quote?.activeJob && quote.activeJob.mode === "TEST" && eff === "LIVE");
  const needsRepeat = Boolean(quote?.alreadySent) && !testBlocksLive;
  const problems = quote?.problems ?? [];
  const priceMissing = sending && quote !== null && quote.priceCents === null;
  const blocked = !quote || problems.length > 0 || testBlocksLive || priceMissing || !confirmed || (needsRepeat && !repeat);
  const priceText = quote?.priceCents != null ? formatCents(quote.priceCents) : null;

  let sendLabel = "Trockenlauf protokollieren";
  if (eff === "LIVE") sendLabel = `Kostenpflichtig per Post senden${priceText ? ` (${priceText})` : ""}`;
  else if (eff === "TEST") sendLabel = `In die Postbox des Briefdienstes übertragen${priceText ? ` (${priceText})` : ""}`;

  const done = result !== null && result.status !== "REJECTED";

  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        className={className ?? "rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper"}
      >
        {label}
      </button>
      <dialog ref={dialogRef} className="w-full max-w-xl rounded-lg border border-rule p-0 backdrop:bg-ink/40">
        <div className="max-h-[85vh] space-y-3 overflow-y-auto p-5 text-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">{docType === "DUNNING" ? "Mahnung per Post senden" : "Rechnung per Post senden"}</h2>
            <button type="button" onClick={close} className="text-ink-muted hover:text-ink-soft" aria-label="Schließen">
              ✕
            </button>
          </div>

          {loading && <p className="text-ink-muted">Lade Angebot…</p>}
          {loadError && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-stamp">{loadError}</div>}

          {quote && !done && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-ink-muted">Beleg</dt>
                <dd>{quote.docNumber}</dd>
                <dt className="text-ink-muted">Anschrift</dt>
                <dd className="whitespace-pre-line">{quote.address.join("\n") || "—"}</dd>
                <dt className="text-ink-muted">Seiten</dt>
                <dd>{quote.pages}</dd>
                <dt className="text-ink-muted">Versandart</dt>
                <dd>{quote.shipping === "national" ? "National" : "International"}</dd>
                <dt className="text-ink-muted">Einschreiben</dt>
                <dd>
                  <select
                    value={reg}
                    onChange={(e) => {
                      const v = e.target.value as Reg;
                      setReg(v);
                      setConfirmed(false);
                      void load(v);
                    }}
                    className="rounded-md border border-rule-strong px-2 py-1 text-sm"
                    aria-label="Einschreiben"
                  >
                    <option value="default">Vorgabe aus den Einstellungen{quote.registered ? ` (${REGISTERED_LABEL[quote.registered]})` : ""}</option>
                    <option value="none">Kein Einschreiben</option>
                    <option value="r1">{REGISTERED_LABEL.r1}</option>
                    <option value="r2">{REGISTERED_LABEL.r2}</option>
                  </select>
                </dd>
                <dt className="text-ink-muted">Kosten</dt>
                <dd className="font-medium" data-testid="postal-cost">
                  {priceText
                    ? eff === "DRY_RUN"
                      ? `${priceText} laut Preisabfrage (Trockenlauf, wird nicht berechnet)`
                      : priceText
                    : eff === "OFF_DRY_RUN"
                      ? "Preis wird erst bei eingeschalteter Verbindung abgefragt"
                      : "Preis nicht verfügbar"}
                </dd>
              </dl>

              <div
                role="status"
                className={`rounded-md border p-3 ${
                  eff === "LIVE" ? "border-stamp/30 bg-stamp/10 text-stamp" : eff === "TEST" ? "border-seal/30 bg-seal/10 text-seal" : "border-rule bg-well text-ink-soft"
                }`}
              >
                {eff === "OFF_DRY_RUN" && "Postversand ist ausgeschaltet. Es wird nur ein Trockenlauf protokolliert; nichts wird an den Briefdienst übertragen."}
                {eff === "DRY_RUN" && "Trockenlauf: Es wird nur protokolliert, nichts wird versendet."}
                {eff === "TEST" &&
                  "Modus Test: Der Auftrag wird an den Briefdienst übertragen und landet dort in der Postbox. Er kann dort manuell versendet werden — dann entstehen Druck-, Porto- und Versandkosten."}
                {eff === "LIVE" && "Modus Live: Der Brief wird kostenpflichtig gedruckt und versendet. Die Daten des Belegs gehen an den Briefdienst."}
                {(eff === "TEST" || eff === "LIVE") && priceText && <span className="mt-1 block font-medium">Kosten: {priceText}</span>}
              </div>

              {problems.length > 0 && (
                <ul className="list-disc space-y-0.5 rounded-md border border-stamp/30 bg-stamp/10 p-3 pl-7 text-stamp">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}

              {testBlocksLive && quote.activeJob && (
                <div role="alert" className="space-y-2 rounded-md border border-stamp/30 bg-stamp/10 p-3 text-stamp">
                  <p className="font-medium">Testauftrag zuerst stornieren.</p>
                  <p>Für diesen Beleg besteht ein Testauftrag in der Postbox des Briefdienstes. Er kann dort manuell versendet werden; ein Live-Versand würde den Brief doppelt auslösen.</p>
                  {quote.activeJob.cancellable ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void cancelActive()}
                      className="rounded-md border border-stamp/40 bg-sheet px-3 py-1.5 font-medium text-stamp hover:bg-stamp/10 disabled:opacity-60"
                    >
                      Testauftrag stornieren{quote.activeJob.remainingMs !== null ? ` (noch ${remainingLabel(quote.activeJob.remainingMs)})` : ""}
                    </button>
                  ) : (
                    <p>Der Testauftrag ist nicht mehr stornierbar (Stornofenster von 15 Minuten abgelaufen oder bereits verarbeitet). Bitte in der Postbox des Briefdienstes prüfen.</p>
                  )}
                </div>
              )}

              {needsRepeat && (
                <label className="flex items-start gap-2 rounded-md border border-seal/30 bg-seal/10 p-3 text-seal">
                  <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} className="mt-1 h-4 w-4" />
                  <span>
                    <span className="font-medium">Erneut senden.</span> Dieser Beleg wurde bereits per Post versendet (oder der Versand läuft). Ein weiterer Versand verursacht erneut Kosten.
                  </span>
                </label>
              )}

              {notice && <div className="rounded-md border border-rule bg-paper p-3 text-ink-soft">{notice}</div>}

              <label className="flex items-start gap-2">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 h-4 w-4" />
                <span className="font-medium text-ink-soft">Versand bestätigen</span>
              </label>

              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="text-sm text-ink-muted hover:text-ink">
                  Abbrechen
                </button>
                <button
                  type="button"
                  disabled={blocked || busy}
                  onClick={() => void send()}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-60 ${eff === "LIVE" ? "bg-stamp" : "bg-pen hover:bg-pen-strong"}`}
                >
                  {busy ? "Sende…" : sendLabel}
                </button>
              </div>
            </>
          )}

          {done && result && (
            <div className="space-y-3">
              <div role="status" className="rounded-md border border-ledger/30 bg-ledger/10 p-3 text-ledger">
                {result.status === "DRY_RUN"
                  ? "Trockenlauf protokolliert. Es wurde nichts versendet."
                  : `Übertragen an den Briefdienst (${MODE_LABEL[eff] ?? eff}). Stornieren ist im Postversand-Verlauf noch 15 Minuten möglich.`}
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={close} className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper">
                  Schließen
                </button>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
