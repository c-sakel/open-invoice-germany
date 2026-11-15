"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { saveOnlinePaymentSettingsAction } from "@/app/einstellungen/online-zahlung/actions";
import type { OnlinePaymentSettingsView } from "@/domain/online-payment/settings";
import { PROVIDER_LABEL } from "@/domain/online-payment/ui";
import { ONLINE_PROVIDERS, type OnlineProvider } from "@/lib/payment/types";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { ProviderAccountSection } from "./ProviderAccountSection";

export function OnlinePaymentSettingsForm({
  initial,
  baseUrlSet,
  authSecretMissing = false,
  webhookUrls = {},
  methodOptions = {},
}: {
  initial: OnlinePaymentSettingsView;
  baseUrlSet: boolean;
  authSecretMissing?: boolean;
  /** Webhook-Adressen je Anbieter mit Signatur (nur Einstellungsseite). */
  webhookUrls?: Partial<Record<OnlineProvider, string | null>>;
  /** Auswahllisten der Zahlarten je Anbieter (fehlt = Freitext). */
  methodOptions?: Partial<Record<OnlineProvider, readonly string[]>>;
}) {
  const [settings, setSettings] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [defaultProvider, setDefaultProvider] = useState(settings.defaultProvider);
  const [showOnPdf, setShowOnPdf] = useState(settings.showOnPdf);
  const [showInMail, setShowInMail] = useState(settings.showInMail);
  const [showInPortal, setShowInPortal] = useState(settings.showInPortal);

  function begin() {
    setError(null);
    setNotice(null);
  }

  function apply(res: { ok: true; settings: OnlinePaymentSettingsView } | { ok: false; error: string }, okText: string) {
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSettings(res.settings);
    setNotice(okText);
  }

  function saveGeneral(e: React.FormEvent) {
    e.preventDefault();
    begin();
    start(async () => {
      apply(await saveOnlinePaymentSettingsAction({ defaultProvider, showOnPdf, showInMail, showInPortal }), "Einstellungen gespeichert.");
    });
  }

  return (
    <div className="space-y-6">
      {!baseUrlSet && (
        <div role="alert" className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
          APP_BASE_URL ist nicht gesetzt. Ohne öffentliche Adresse kann der Zahlungsanbieter den Zahlungsstatus nicht zurückmelden; die Anbindung lässt sich nicht einschalten.
        </div>
      )}
      {authSecretMissing && (
        <div role="alert" className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
          AUTH_SECRET ist nicht gesetzt — der API-Schlüssel kann nicht verschlüsselt gespeichert werden.
        </div>
      )}
      <ErrorBanner message={error ?? undefined} />
      {notice && <p role="status" className="rounded-md border border-ledger/30 bg-ledger/10 p-3 text-sm text-ledger">{notice}</p>}

      {settings.accounts.map((account) => (
        <ProviderAccountSection
          key={account.provider}
          account={account}
          baseUrlSet={baseUrlSet}
          webhookUrl={webhookUrls[account.provider] ?? null}
          knownMethods={methodOptions[account.provider] ?? null}
          onSettings={setSettings}
        />
      ))}

      <form onSubmit={saveGeneral} className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Vorgaben</h2>
        <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
          <span className="font-medium text-ink-soft">Standardanbieter</span>
          <select className={inputCls} value={defaultProvider} onChange={(e) => setDefaultProvider(ONLINE_PROVIDERS.find((p) => p === e.target.value) ?? "NONE")}>
            <option value="NONE">Keiner (kein Bezahllink)</option>
            {ONLINE_PROVIDERS.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
            ))}
          </select>
          <span className="text-xs text-ink-muted">Vorrang: Zahlungsmethode, dann Kunde, dann diese Voreinstellung.</span>
        </label>
        <fieldset className="space-y-2 text-sm">
          <legend className="font-medium text-ink-soft">Bezahllink anzeigen in</legend>
          {[
            { label: "Rechnungs-PDF", v: showOnPdf, set: setShowOnPdf },
            { label: "E-Mail (über den Platzhalter)", v: showInMail, set: setShowInMail },
            { label: "Kundenportal", v: showInPortal, set: setShowInPortal },
          ].map((o) => (
            <label key={o.label} className="flex items-center gap-2">
              <input type="checkbox" checked={o.v} onChange={(e) => o.set(e.target.checked)} className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" />
              {o.label}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-ink-muted">
          In E-Mails erscheint der Link nur, wenn die Vorlage den Platzhalter <code>{"{{invoice.paymentLink}}"}</code> enthält. Vorlagen pflegen Sie unter{" "}
          <Link href="/einstellungen/vorlagen" className="text-pen hover:underline">Textvorlagen</Link>.
        </p>
        <button type="submit" disabled={pending} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          Vorgaben speichern
        </button>
      </form>
    </div>
  );
}
