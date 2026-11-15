"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  saveOnlinePaymentSettingsAction,
  saveProviderOptionsAction,
  setProviderApiKeyAction,
  setProviderEnabledAction,
  testProviderConnectionAction,
} from "@/app/einstellungen/online-zahlung/actions";
import type { OnlinePaymentSettingsView, ProviderAccountView } from "@/domain/online-payment/settings";
import { canEnableProvider, MODE_LABEL } from "@/domain/online-payment/ui";
import { TWO_DECIMAL_CURRENCIES } from "@/lib/payment/amount";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { deDateTimeValue } from "./format";

const PROVIDER_LABEL: Record<string, string> = { MOLLIE: "Mollie" };

export function OnlinePaymentSettingsForm({
  initial,
  baseUrlSet,
  authSecretMissing = false,
}: {
  initial: OnlinePaymentSettingsView;
  baseUrlSet: boolean;
  authSecretMissing?: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mollie: ProviderAccountView = settings.accounts.find((a) => a.provider === "MOLLIE") ?? {
    provider: "MOLLIE",
    enabled: false,
    mode: null,
    hasApiKey: false,
    apiKeyLast4: null,
    requiresWebhookSecret: false,
    hasWebhookSecret: false,
    allowedMethods: null,
    currencies: ["EUR"],
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
  };

  // Eingabefelder: der Schluessel wird nie vorbefuellt und nach dem Speichern geleert.
  const [apiKey, setApiKey] = useState("");
  const [defaultProvider, setDefaultProvider] = useState(settings.defaultProvider);
  const [showOnPdf, setShowOnPdf] = useState(settings.showOnPdf);
  const [showInMail, setShowInMail] = useState(settings.showInMail);
  const [showInPortal, setShowInPortal] = useState(settings.showInPortal);
  const [methods, setMethods] = useState((mollie.allowedMethods ?? []).join(", "));
  const [currencies, setCurrencies] = useState<string[]>(mollie.currencies);
  const [testedMethods, setTestedMethods] = useState<string[] | null>(null);

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

  function saveKey(e: React.FormEvent) {
    e.preventDefault();
    begin();
    if (apiKey.trim() === "") {
      setError("Bitte den Schlüssel eingeben.");
      return;
    }
    const wasEnabled = mollie.enabled;
    const key = apiKey;
    start(async () => {
      const res = await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: key });
      setApiKey("");
      setTestedMethods(null);
      apply(
        res,
        wasEnabled
          ? "Schlüssel gespeichert. Der Schlüsselwechsel hat die Anbindung ausgeschaltet — bitte Verbindung prüfen und danach erneut einschalten."
          : "Schlüssel gespeichert. Bitte jetzt die Verbindung prüfen.",
      );
    });
  }

  function removeKey() {
    begin();
    if (!window.confirm("Den hinterlegten Schlüssel entfernen? Die Anbindung wird ausgeschaltet.")) return;
    start(async () => {
      setTestedMethods(null);
      apply(await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: null }), "Schlüssel entfernt, Anbindung ausgeschaltet.");
    });
  }

  function testConnection() {
    begin();
    if (!window.confirm("Das baut eine echte Verbindung zu Mollie auf. Fortfahren?")) return;
    start(async () => {
      const res = await testProviderConnectionAction({ provider: "MOLLIE" });
      if (res.settings) setSettings(res.settings);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTestedMethods(res.methods);
      setNotice("Verbindung in Ordnung. Die Anbindung kann jetzt eingeschaltet werden.");
    });
  }

  function toggleEnabled(next: boolean) {
    begin();
    start(async () => {
      apply(await setProviderEnabledAction({ provider: "MOLLIE", enabled: next }), next ? "Anbindung eingeschaltet." : "Anbindung ausgeschaltet.");
    });
  }

  function saveOptions(e: React.FormEvent) {
    e.preventDefault();
    begin();
    const list = methods
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    start(async () => {
      apply(
        await saveProviderOptionsAction({ provider: "MOLLIE", options: { allowedMethods: list.length > 0 ? list : null, currencies } }),
        "Methoden und Währungen gespeichert.",
      );
    });
  }

  const canEnable = canEnableProvider(mollie, baseUrlSet);
  const isTest = mollie.mode === "TEST";

  return (
    <div className="space-y-6">
      {isTest && (
        <div role="status" className="rounded-md border border-seal/40 bg-seal/10 p-3 text-sm font-medium text-seal">
          TESTMODUS: Zahlungen im Testmodus werden nicht gebucht. Es erscheint nur eine Anzeige und ein Eintrag im Protokoll.
        </div>
      )}
      {!baseUrlSet && (
        <div role="alert" className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
          APP_BASE_URL ist nicht gesetzt. Ohne öffentliche Adresse kann Mollie den Zahlungsstatus nicht zurückmelden; die Anbindung lässt sich nicht einschalten.
        </div>
      )}
      {authSecretMissing && (
        <div role="alert" className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
          AUTH_SECRET ist nicht gesetzt — der API-Schlüssel kann nicht verschlüsselt gespeichert werden.
        </div>
      )}
      <ErrorBanner message={error ?? undefined} />
      {notice && <p role="status" className="rounded-md border border-ledger/30 bg-ledger/10 p-3 text-sm text-ledger">{notice}</p>}

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-ink">{PROVIDER_LABEL.MOLLIE}</h2>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${mollie.enabled ? "bg-ledger/10 text-ledger" : "bg-well text-ink-soft"}`}>
            {mollie.enabled ? "eingeschaltet" : "ausgeschaltet"}
          </span>
        </div>

        <p className="text-sm text-ink-soft" data-testid="key-state">
          {mollie.hasApiKey ? (
            <>
              Schlüssel hinterlegt{mollie.apiKeyLast4 ? ` (…${mollie.apiKeyLast4})` : ""}
              {mollie.mode ? `, ${MODE_LABEL[mollie.mode]}` : ""}.
            </>
          ) : (
            "Noch kein Schlüssel hinterlegt."
          )}
        </p>

        <form onSubmit={saveKey} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">API-Schlüssel</span>
            <input
              className={inputCls}
              type="password"
              name="apiKey"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={mollie.hasApiKey ? "Neuen Schlüssel eingeben, um ihn zu ersetzen" : "Schlüssel eingeben"}
            />
            <span className="text-xs text-ink-muted">Wird verschlüsselt gespeichert und nie wieder angezeigt. Jeder Schlüsselwechsel schaltet die Anbindung aus; danach neu prüfen und einschalten.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
              Schlüssel speichern
            </button>
            {mollie.hasApiKey && (
              <button type="button" onClick={removeKey} disabled={pending} className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-stamp hover:bg-paper disabled:opacity-60">
                Entfernen
              </button>
            )}
          </div>
        </form>

        <div className="space-y-2 border-t border-rule pt-4">
          <h3 className="text-sm font-semibold text-ink">Verbindung prüfen</h3>
          <p className="text-sm text-ink-soft">Baut eine echte Verbindung zu Mollie auf und liest nur die verfügbaren Zahlarten. Es wird nichts gebucht.</p>
          <button
            type="button"
            onClick={testConnection}
            disabled={pending || !mollie.hasApiKey}
            className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60"
          >
            {pending ? "Bitte warten…" : "Verbindung prüfen"}
          </button>
          {mollie.lastTestAt && (
            <p className="text-sm text-ink-soft">
              Letzte Prüfung: {deDateTimeValue(mollie.lastTestAt)}{" "}
              {mollie.lastTestOk ? (
                <span className="font-medium text-ledger">erfolgreich</span>
              ) : (
                <span className="font-medium text-stamp">fehlgeschlagen{mollie.lastTestError ? `: ${mollie.lastTestError}` : ""}</span>
              )}
            </p>
          )}
          {testedMethods && testedMethods.length > 0 && <p className="text-xs text-ink-muted">Verfügbare Zahlarten: {testedMethods.join(", ")}</p>}
        </div>

        <div className="space-y-2 border-t border-rule pt-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              checked={mollie.enabled}
              disabled={pending || (!mollie.enabled && !canEnable)}
              onChange={(e) => toggleEnabled(e.target.checked)}
              className="mt-1 h-4 w-4 rounded-[var(--radius-control)] border-rule-strong"
            />
            <span>
              <span className="font-medium text-ink-soft">Online-Zahlung mit Mollie einschalten</span>
              <span className="block text-xs text-ink-muted">
                {canEnable || mollie.enabled
                  ? "Neue Rechnungen erhalten nach den Vorgaben einen Bezahllink."
                  : "Einschalten erst nach erfolgreicher Prüfung des aktuell hinterlegten Schlüssels (und gesetzter APP_BASE_URL)."}
              </span>
            </span>
          </label>
        </div>

        <form onSubmit={saveOptions} className="space-y-3 border-t border-rule pt-4">
          <h3 className="text-sm font-semibold text-ink">Zahlarten und Währungen</h3>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Erlaubte Zahlarten (Kennungen, durch Komma getrennt)</span>
            <input className={inputCls} value={methods} onChange={(e) => setMethods(e.target.value)} placeholder="leer = alle aktiven Zahlarten, z. B. creditcard, paypal" />
          </label>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium text-ink-soft">Währungen</legend>
            <div className="flex flex-wrap gap-3">
              {TWO_DECIMAL_CURRENCIES.map((c) => (
                <label key={c} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={currencies.includes(c)}
                    onChange={(e) => setCurrencies((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))}
                    className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong"
                  />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
          <button type="submit" disabled={pending || currencies.length === 0} className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60">
            Zahlarten und Währungen speichern
          </button>
        </form>

        <p className="border-t border-rule pt-3 text-xs text-ink-muted">
          Die Webhook-Adresse für Statusmeldungen wird bei jedem Zahlungsvorgang automatisch an Mollie übergeben; es muss nichts eingetragen werden. Sie setzt eine öffentlich erreichbare APP_BASE_URL voraus.
        </p>
      </section>

      <form onSubmit={saveGeneral} className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Vorgaben</h2>
        <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
          <span className="font-medium text-ink-soft">Standardanbieter</span>
          <select className={inputCls} value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value === "MOLLIE" ? "MOLLIE" : "NONE")}>
            <option value="NONE">Keiner (kein Bezahllink)</option>
            <option value="MOLLIE">Mollie</option>
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
