"use client";

import { useState, useTransition } from "react";
import { disablePayLinkAction, ensurePayLinkAction, refreshPayLinkAction, type PayLinkActionResult } from "@/app/rechnungen/[id]/pay-link-actions";
import type { InvoicePayLinkView } from "@/domain/online-payment/views";
import { ATTEMPT_STATUS_LABEL, LINK_DISABLED_LABEL, MODE_LABEL, payLinkActions } from "@/domain/online-payment/ui";
import { formatCents } from "@/lib/money";
import { ErrorBanner } from "@/components/forms/fields";
import { deDateTimeValue } from "./format";

const btn = "rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60";

/** Bezahllink einer Rechnung: Status, Adresse, Vorgaenge und Aktionen. Interne Ansicht, nie im Beleg. */
export function PayLinkSection({
  invoiceId,
  initial,
  invoiceCancelled,
  mode,
  providerEnabled,
}: {
  invoiceId: string;
  initial: InvoicePayLinkView;
  invoiceCancelled: boolean;
  /** Modus des Anbieterzugangs; TEST = Zahlungen werden nicht gebucht. */
  mode: "TEST" | "LIVE" | null;
  providerEnabled: boolean;
}) {
  const [view, setView] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const a = payLinkActions(view, { invoiceCancelled, hasUrl: view.url !== null });
  const link = view.link;
  const isTest = mode === "TEST";

  function run(fn: () => Promise<PayLinkActionResult>) {
    setError(null);
    setMessage(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setView(res.view);
      if (res.message) setMessage(res.message);
    });
  }

  function disable() {
    if (!window.confirm("Den Bezahllink deaktivieren? Der Kunde kann dann nicht mehr online zahlen.")) return;
    run(() => disablePayLinkAction(invoiceId));
  }

  async function copy() {
    if (!view.url) return;
    try {
      await navigator.clipboard.writeText(view.url);
      setCopied(true);
    } catch {
      setError("Kopieren nicht möglich — Adresse bitte von Hand markieren.");
    }
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-4">
      {isTest && (
        <div role="status" className="rounded-md border border-seal/40 bg-seal/10 p-2 text-sm font-medium text-seal">
          {MODE_LABEL.TEST}: Zahlungen werden nicht gebucht. Der Link ist nur zum internen Ausprobieren gedacht.
        </div>
      )}
      <ErrorBanner message={error ?? undefined} />
      {message && <p role="status" className="text-sm text-ledger">{message}</p>}

      <p className="text-sm text-ink-soft">
        {link === null && "Kein Bezahllink vorhanden."}
        {link?.status === "ACTIVE" && "Bezahllink aktiv."}
        {link && link.status !== "ACTIVE" && `Bezahllink deaktiviert${link.disabledReason ? ` (${LINK_DISABLED_LABEL[link.disabledReason] ?? link.disabledReason})` : ""}.`}
        {link && <> Im PDF: <span className="font-medium">{link.onDocument ? "ja" : "nein"}</span>.</>}
      </p>
      {link === null && !providerEnabled && !invoiceCancelled && (
        <p className="text-xs text-ink-muted">Der Zahlungsanbieter ist unter Einstellungen → Online-Zahlung noch nicht eingeschaltet.</p>
      )}

      {a.copy && view.url && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input readOnly value={view.url} aria-label="Bezahladresse" className="min-w-0 flex-1 rounded-md border border-rule-strong bg-well px-3 py-1.5 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={copy}>{copied ? "Kopiert" : "Adresse kopieren"}</button>
            {a.open && (
              <a href={view.url} target="_blank" rel="noopener noreferrer" className={btn}>
                {isTest ? "Testlink öffnen (nur intern)" : "Link öffnen"}
              </a>
            )}
          </div>
        </div>
      )}
      {link?.status === "ACTIVE" && view.url === null && <p className="text-xs text-ink-muted">Adresse nicht verfügbar: APP_BASE_URL ist nicht gesetzt.</p>}

      <div className="flex flex-wrap gap-2">
        {a.create && <button type="button" className={btn} disabled={pending} onClick={() => run(() => ensurePayLinkAction(invoiceId))}>Bezahllink anlegen</button>}
        {a.reactivate && <button type="button" className={btn} disabled={pending} onClick={() => run(() => ensurePayLinkAction(invoiceId))}>Reaktivieren</button>}
        {a.disable && <button type="button" className={`${btn} text-stamp`} disabled={pending} onClick={disable}>Deaktivieren</button>}
        {a.refresh && <button type="button" className={btn} disabled={pending} onClick={() => run(() => refreshPayLinkAction(invoiceId))}>Status abrufen</button>}
      </div>

      {view.attempts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="py-1 pr-3">Zeit</th>
                <th className="py-1 pr-3 text-right">Betrag</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {view.attempts.map((t) => (
                <tr key={t.id}>
                  <td className="py-1 pr-3 whitespace-nowrap">{deDateTimeValue(t.createdAt)}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap">{formatCents(t.amountCents, t.currency)}</td>
                  <td className="py-1">
                    {ATTEMPT_STATUS_LABEL[t.status] ?? t.status}
                    {t.error === "Anlage unklar" && (
                      <span className="mt-0.5 block text-xs text-stamp">Anlage unklar: Beim Anbieter prüfen, ob dort eine Zahlung entstanden ist, bevor der Kunde es erneut versucht.</span>
                    )}
                    {t.error !== null && t.error !== "Anlage unklar" && (
                      <span className="mt-0.5 block text-xs text-stamp">{t.error}</span>
                    )}
                    {t.overpaidCents !== null && t.overpaidCents > 0 && (
                      <span className="mt-0.5 block text-xs text-seal">Überzahlung {formatCents(t.overpaidCents, t.currency)}: nicht gebucht, beim Anbieter von Hand zu erstatten.</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
