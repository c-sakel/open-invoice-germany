"use client";

import { useState, useTransition } from "react";
import {
  saveProviderOptionsAction,
  setProviderApiKeyAction,
  setProviderEnabledAction,
  setProviderWebhookSecretAction,
  testProviderConnectionAction,
} from "@/app/einstellungen/online-zahlung/actions";
import type { OnlinePaymentSettingsView, ProviderAccountView } from "@/domain/online-payment/settings";
import { canEnableProvider, MODE_LABEL, PROVIDER_LABEL, STRIPE_WEBHOOK_EVENTS } from "@/domain/online-payment/ui";
import { TWO_DECIMAL_CURRENCIES } from "@/lib/payment/amount";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { deDateTimeValue } from "./format";

const btnPrimary = "rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60";
const btnSecondary = "rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60";

/** Zugang eines Zahlungsanbieters: Schluessel, Signaturschluessel, Webhook-Adresse, Verbindungstest, Einschalten, Methoden. Keine Logik. */
export function ProviderAccountSection({
  account,
  baseUrlSet,
  webhookUrl,
  knownMethods,
  onSettings,
}: {
  account: ProviderAccountView;
  baseUrlSet: boolean;
  /** Adresse fuer das Ereignisziel beim Anbieter (nur Anbieter mit Signatur); null = noch nicht verfuegbar. */
  webhookUrl: string | null;
  /** Auswahlliste der Zahlarten; null = Freitext. */
  knownMethods: readonly string[] | null;
  onSettings: (s: OnlinePaymentSettingsView) => void;
}) {
  const provider = account.provider;
  const label = PROVIDER_LABEL[provider];
  const signed = account.requiresWebhookSecret;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Eingabefelder: Schluessel werden nie vorbefuellt und nach dem Speichern geleert.
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [methods, setMethods] = useState<string[]>(account.allowedMethods ?? []);
  const [methodsText, setMethodsText] = useState((account.allowedMethods ?? []).join(", "));
  const [currencies, setCurrencies] = useState<string[]>(account.currencies);
  const [testedMethods, setTestedMethods] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  function begin() {
    setError(null);
    setNotice(null);
  }

  function apply(res: { ok: true; settings: OnlinePaymentSettingsView } | { ok: false; error: string }, okText: string) {
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSettings(res.settings);
    setNotice(okText);
  }

  function saveKey(e: React.FormEvent) {
    e.preventDefault();
    begin();
    if (apiKey.trim() === "") {
      setError("Bitte den Schlüssel eingeben.");
      return;
    }
    const wasEnabled = account.enabled;
    const key = apiKey;
    start(async () => {
      const res = await setProviderApiKeyAction({ provider, apiKey: key });
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
      apply(await setProviderApiKeyAction({ provider, apiKey: null }), "Schlüssel entfernt, Anbindung ausgeschaltet.");
    });
  }

  function saveSecret(e: React.FormEvent) {
    e.preventDefault();
    begin();
    if (secret.trim() === "") {
      setError("Bitte den Signaturschlüssel eingeben.");
      return;
    }
    const wasEnabled = account.enabled;
    const value = secret;
    start(async () => {
      const res = await setProviderWebhookSecretAction({ provider, secret: value });
      setSecret("");
      apply(
        res,
        wasEnabled
          ? "Signaturschlüssel gespeichert. Der Wechsel hat die Anbindung ausgeschaltet — bitte erneut einschalten."
          : "Signaturschlüssel gespeichert.",
      );
    });
  }

  function removeSecret() {
    begin();
    if (!window.confirm("Den Signaturschlüssel entfernen? Die Anbindung wird ausgeschaltet.")) return;
    start(async () => {
      apply(await setProviderWebhookSecretAction({ provider, secret: null }), "Signaturschlüssel entfernt, Anbindung ausgeschaltet.");
    });
  }

  function testConnection() {
    begin();
    if (!window.confirm(`Das baut eine echte Verbindung zu ${label} auf. Fortfahren?`)) return;
    start(async () => {
      const res = await testProviderConnectionAction({ provider });
      if (res.settings) onSettings(res.settings);
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
      apply(await setProviderEnabledAction({ provider, enabled: next }), next ? "Anbindung eingeschaltet." : "Anbindung ausgeschaltet.");
    });
  }

  function saveOptions(e: React.FormEvent) {
    e.preventDefault();
    begin();
    const list =
      knownMethods !== null
        ? methods
        : methodsText
            .split(",")
            .map((m) => m.trim())
            .filter((m) => m !== "");
    start(async () => {
      apply(
        await saveProviderOptionsAction({ provider, options: { allowedMethods: list.length > 0 ? list : null, currencies } }),
        "Methoden und Währungen gespeichert.",
      );
    });
  }

  async function copyUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
    } catch {
      setError("Kopieren nicht möglich. Bitte die Adresse markieren und von Hand kopieren.");
    }
  }

  const canEnable = canEnableProvider(account, baseUrlSet);
  const isTest = account.mode === "TEST";
  const enableHint = signed
    ? "Einschalten erst nach hinterlegtem Signaturschlüssel und erfolgreicher Prüfung des aktuell hinterlegten Schlüssels (und gesetzter APP_BASE_URL)."
    : "Einschalten erst nach erfolgreicher Prüfung des aktuell hinterlegten Schlüssels (und gesetzter APP_BASE_URL).";

  return (
    <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5" data-testid={`provider-${provider}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-ink">{label}</h2>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${account.enabled ? "bg-ledger/10 text-ledger" : "bg-well text-ink-soft"}`}>
          {account.enabled ? "eingeschaltet" : "ausgeschaltet"}
        </span>
      </div>

      {isTest && (
        <div role="status" className="rounded-md border border-seal/40 bg-seal/10 p-3 text-sm font-medium text-seal">
          TESTMODUS ({label}): Zahlungen im Testmodus werden nicht gebucht. Es erscheint nur eine Anzeige und ein Eintrag im Protokoll.
        </div>
      )}
      <ErrorBanner message={error ?? undefined} />
      {notice && <p role="status" className="rounded-md border border-ledger/30 bg-ledger/10 p-3 text-sm text-ledger">{notice}</p>}

      <p className="text-sm text-ink-soft" data-testid="key-state">
        {account.hasApiKey ? (
          <>
            Schlüssel hinterlegt{account.apiKeyLast4 ? ` (…${account.apiKeyLast4})` : ""}
            {account.mode ? `, ${MODE_LABEL[account.mode]}` : ""}.
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
            placeholder={account.hasApiKey ? "Neuen Schlüssel eingeben, um ihn zu ersetzen" : "Schlüssel eingeben"}
          />
          <span className="text-xs text-ink-muted">Wird verschlüsselt gespeichert und nie wieder angezeigt. Jeder Schlüsselwechsel schaltet die Anbindung aus; danach neu prüfen und einschalten.</span>
          {provider === "STRIPE" && (
            <span className="text-xs text-ink-muted" data-testid="restricted-key-hint">
              Empfohlen: ein eingeschränkter Schlüssel (<code>rk_live_…</code>) mit den Rechten Checkout Sessions schreiben sowie PaymentIntents, Charges und Disputes lesen. Ein vollständiger Schlüssel (<code>sk_live_…</code>) wird ebenfalls akzeptiert.
            </span>
          )}
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className={btnPrimary}>Schlüssel speichern</button>
          {account.hasApiKey && (
            <button type="button" onClick={removeKey} disabled={pending} className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-stamp hover:bg-paper disabled:opacity-60">
              Entfernen
            </button>
          )}
        </div>
      </form>

      {signed && (
        <div className="space-y-3 border-t border-rule pt-4">
          <h3 className="text-sm font-semibold text-ink">Benachrichtigungen (Ereignisziel)</h3>
          <p className="text-sm text-ink-soft">
            Den Endpunkt legen Sie selbst im {label}-Dashboard an (Entwickler, Ereignisziele). Tragen Sie dort die folgende Adresse und die Ereignisse ein; das Ereignisziel muss das Format „Snapshot“ haben.
          </p>
          <div className="space-y-1 text-sm">
            <span className="font-medium text-ink-soft">Webhook-Adresse</span>
            {webhookUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded bg-well px-2 py-1 text-xs" data-testid="webhook-url">{webhookUrl}</code>
                <button type="button" onClick={copyUrl} className={btnSecondary}>{copied ? "Kopiert" : "Adresse kopieren"}</button>
              </div>
            ) : (
              <p className="text-xs text-ink-muted">
                {baseUrlSet ? "Die Adresse erscheint, sobald ein Schlüssel hinterlegt ist." : "Die Adresse erscheint, sobald APP_BASE_URL gesetzt und ein Schlüssel hinterlegt ist."}
              </p>
            )}
          </div>
          <div className="space-y-1 text-sm">
            <span className="font-medium text-ink-soft">Ereignisse (alle acht auswählen)</span>
            <ul className="list-disc pl-5 text-xs text-ink-soft" data-testid="webhook-events">
              {STRIPE_WEBHOOK_EVENTS.map((ev) => (
                <li key={ev}><code>{ev}</code></li>
              ))}
            </ul>
          </div>
          <form onSubmit={saveSecret} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Signaturschlüssel (<code>whsec_…</code>)</span>
              <input
                className={inputCls}
                type="password"
                name="webhookSecret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={account.hasWebhookSecret ? "Neuen Signaturschlüssel eingeben, um ihn zu ersetzen" : "Signaturschlüssel eingeben"}
              />
              <span className="text-xs text-ink-muted" data-testid="secret-state">
                {account.hasWebhookSecret ? "Signaturschlüssel hinterlegt." : "Noch kein Signaturschlüssel hinterlegt."} Er wird verschlüsselt gespeichert und nie wieder angezeigt; jeder Wechsel schaltet die Anbindung aus.
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={pending} className={btnPrimary}>Signaturschlüssel speichern</button>
              {account.hasWebhookSecret && (
                <button type="button" onClick={removeSecret} disabled={pending} className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-stamp hover:bg-paper disabled:opacity-60">
                  Entfernen
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      <div className="space-y-2 border-t border-rule pt-4">
        <h3 className="text-sm font-semibold text-ink">Verbindung prüfen</h3>
        <p className="text-sm text-ink-soft">
          Baut eine echte Verbindung zu {label} auf und liest nur{provider === "STRIPE" ? " die Checkout-Sitzungen (höchstens eine)" : " die verfügbaren Zahlarten"}. Es wird nichts gebucht.
        </p>
        <button type="button" onClick={testConnection} disabled={pending || !account.hasApiKey} className={btnSecondary}>
          {pending ? "Bitte warten…" : "Verbindung prüfen"}
        </button>
        {account.lastTestAt && (
          <p className="text-sm text-ink-soft">
            Letzte Prüfung: {deDateTimeValue(account.lastTestAt)}{" "}
            {account.lastTestOk ? (
              <span className="font-medium text-ledger">erfolgreich</span>
            ) : (
              <span className="font-medium text-stamp">fehlgeschlagen{account.lastTestError ? `: ${account.lastTestError}` : ""}</span>
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
            checked={account.enabled}
            disabled={pending || (!account.enabled && !canEnable)}
            onChange={(e) => toggleEnabled(e.target.checked)}
            className="mt-1 h-4 w-4 rounded-[var(--radius-control)] border-rule-strong"
          />
          <span>
            <span className="font-medium text-ink-soft">Online-Zahlung mit {label} einschalten</span>
            <span className="block text-xs text-ink-muted">
              {canEnable || account.enabled ? "Neue Rechnungen erhalten nach den Vorgaben einen Bezahllink." : enableHint}
            </span>
          </span>
        </label>
      </div>

      <form onSubmit={saveOptions} className="space-y-3 border-t border-rule pt-4">
        <h3 className="text-sm font-semibold text-ink">Zahlarten und Währungen</h3>
        {knownMethods !== null ? (
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium text-ink-soft">Erlaubte Zahlarten (keine Auswahl = alle im Dashboard aktivierten)</legend>
            <div className="flex max-h-44 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-rule p-2">
              {knownMethods.map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={methods.includes(m)}
                    onChange={(e) => setMethods((cur) => (e.target.checked ? [...cur, m] : cur.filter((x) => x !== m)))}
                    className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong"
                  />
                  {m}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Erlaubte Zahlarten (Kennungen, durch Komma getrennt)</span>
            <input className={inputCls} value={methodsText} onChange={(e) => setMethodsText(e.target.value)} placeholder="leer = alle aktiven Zahlarten, z. B. creditcard, paypal" />
          </label>
        )}
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
        <button type="submit" disabled={pending || currencies.length === 0} className={btnSecondary}>
          Zahlarten und Währungen speichern
        </button>
      </form>

      {!signed && (
        <p className="border-t border-rule pt-3 text-xs text-ink-muted">
          Die Webhook-Adresse für Statusmeldungen wird bei jedem Zahlungsvorgang automatisch an {label} übergeben; es muss nichts eingetragen werden. Sie setzt eine öffentlich erreichbare APP_BASE_URL voraus.
        </p>
      )}
    </section>
  );
}
