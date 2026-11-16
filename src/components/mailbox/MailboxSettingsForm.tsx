"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  fetchMailboxNowAction,
  saveMailboxSettingsAction,
  setMailboxEnabledAction,
  testMailboxConnectionAction,
} from "@/app/einstellungen/postfach/actions";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { MailboxSettingsClientView } from "./mailbox-actions-core";
import { MAILBOX_NOTICE, PASSWORD_AGAIN_NOTICE, SENDER_FILTER_WARNING } from "./mailbox-ui";
import { MailboxStatus } from "./MailboxStatus";

type Transport = "993-TLS" | "143-STARTTLS";

function transportOf(v: MailboxSettingsClientView): Transport {
  return v.port === 143 ? "143-STARTTLS" : "993-TLS";
}

/** Einstellungen des Rechnungs-Postfachs. Das Passwort wird nie vorbefüllt und nie zurückgegeben. */
export function MailboxSettingsForm({ initial }: { initial: MailboxSettingsClientView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [view, setView] = useState(initial);
  const [host, setHost] = useState(initial.host);
  const [transport, setTransport] = useState<Transport>(transportOf(initial));
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState(initial.folder);
  const [fetchSince, setFetchSince] = useState(initial.fetchSince);
  const [domains, setDomains] = useState(initial.allowedSenderDomains.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  function run(fn: () => Promise<void>) {
    setError(null);
    setInfo(null);
    start(async () => {
      await fn();
      router.refresh();
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      host,
      port: transport === "143-STARTTLS" ? 143 : 993,
      security: transport === "143-STARTTLS" ? "STARTTLS" : "TLS",
      username,
      ...(password === "" ? {} : { password }),
      folder,
      fetchSince: fetchSince === "" ? null : fetchSince,
      allowedSenderDomains: domains.split("\n").map((d) => d.trim()).filter((d) => d !== ""),
    };
    run(async () => {
      const r = await saveMailboxSettingsAction(payload);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setView(r.data);
      setPassword("");
      setSavedOnce(true);
      setInfo("Einstellungen gespeichert.");
    });
  }

  function test() {
    run(async () => {
      const r = await testMailboxConnectionAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setView(r.data.settings);
      setInfo(`Verbindung erfolgreich. Ungelesene Mails im Ordner: ${r.data.unseen}.`);
    });
  }

  function toggle(enabled: boolean) {
    run(async () => {
      const r = await setMailboxEnabledAction(enabled);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setView(r.data);
      setInfo(enabled ? "Der Abruf ist eingeschaltet." : "Der Abruf ist ausgeschaltet.");
    });
  }

  function fetchNow() {
    run(async () => {
      const r = await fetchMailboxNowAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setInfo(`Abruf abgeschlossen: ${r.data.messages} Mail(s), ${r.data.staged} neue Anlage(n) zur Sichtung.`);
    });
  }

  const enableDisabled = pending || !view.canEnable;

  return (
    <div className="space-y-6">
      <p role="note" className="max-w-3xl rounded-md border border-rule bg-paper p-3 text-sm text-ink-soft">
        {MAILBOX_NOTICE}
      </p>
      <p role="note" className="max-w-3xl rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-ink">
        {SENDER_FILTER_WARNING}
      </p>

      <MailboxStatus view={view} />
      <ErrorBanner message={error ?? undefined} />
      {info ? <p className="text-sm text-ledger">{info}</p> : null}
      {savedOnce && !view.hasPassword ? (
        <p role="alert" className="max-w-3xl rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-ink">
          {PASSWORD_AGAIN_NOTICE}
        </p>
      ) : null}

      <form onSubmit={submit} className="space-y-6">
        <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
          <h2 className="font-semibold text-ink">Zugang</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Server (Host)</span>
              <input className={`${inputCls} w-full min-w-0`} value={host} maxLength={253} autoComplete="off" placeholder="imap.example.org" onChange={(e) => setHost(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Port und Sicherheit</span>
              <select className={`${inputCls} w-full min-w-0`} value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
                <option value="993-TLS">993 (TLS)</option>
                <option value="143-STARTTLS">143 (STARTTLS)</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Benutzer</span>
              <input className={`${inputCls} w-full min-w-0`} value={username} maxLength={254} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Passwort bzw. App-Passwort</span>
              <input
                className={`${inputCls} w-full min-w-0`}
                type="password"
                value={password}
                maxLength={512}
                autoComplete="off"
                placeholder={view.hasPassword ? "unverändert lassen" : ""}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="text-xs text-ink-muted">{view.hasPassword ? "Passwort hinterlegt." : "Noch kein Passwort hinterlegt."}</span>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Ordner</span>
              <input className={`${inputCls} w-full min-w-0`} value={folder} maxLength={200} autoComplete="off" onChange={(e) => setFolder(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Abrufbeginn</span>
              <input className={`${inputCls} w-full min-w-0`} type="date" value={fetchSince} onChange={(e) => setFetchSince(e.target.value)} />
              <span className="text-xs text-ink-muted">Nur Mails ab diesem Tag. Leer: Tag des ersten Einschaltens (höchstens 365 Tage zurück).</span>
            </label>
          </div>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Absender-Domains (eine je Zeile, empfohlen)</span>
            <textarea className={`${inputCls} min-h-24 w-full min-w-0`} value={domains} spellCheck={false} placeholder="lieferant.example.org" onChange={(e) => setDomains(e.target.value)} />
            <span className="text-xs text-ink-muted">Leer: Mails aller Absender werden zur Sichtung angenommen.</span>
          </label>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Bitte warten …" : "Speichern"}
          </Button>
        </section>
      </form>

      <section className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Prüfen, einschalten, abrufen</h2>
        <p className="text-xs text-ink-muted">Der Verbindungstest geht nur zum oben eingetragenen und gespeicherten Server. Einschalten ist erst nach einem erfolgreichen Test möglich.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={test}>
            Verbindung testen
          </Button>
          {view.enabled ? (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => toggle(false)}>
              Ausschalten
            </Button>
          ) : (
            <Button type="button" variant="primary" disabled={enableDisabled} onClick={() => toggle(true)}>
              Einschalten
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={pending || !view.enabled} onClick={fetchNow}>
            Jetzt abrufen
          </Button>
        </div>
      </section>
    </div>
  );
}
