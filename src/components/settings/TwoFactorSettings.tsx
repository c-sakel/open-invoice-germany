"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Setup = { secret: string; otpauthUri: string; qrDataUrl: string };

async function post<T>(url: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) return { ok: false, error: j.error ?? "Fehler" };
  return { ok: true, data: j };
}

const input = "rounded-md border border-rule-strong px-3 py-2 text-sm";
const primary = "rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60";
const card = "max-w-md space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5";

function groupFour(s: string): string {
  return s.replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function RecoveryCodeList({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  function save() {
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wiederherstellungscodes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold">Wiederherstellungscodes</h3>
      <p className="text-xs text-ink-muted">Bewahre diese Codes sicher auf. Jeder gilt einmal, falls du keinen Zugriff auf die App hast. Sie werden nicht erneut angezeigt.</p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-3">
        <button type="button" onClick={save} className={primary}>Als Textdatei speichern</button>
        <button type="button" onClick={onDone} className="text-sm text-pen hover:underline">Fertig</button>
      </div>
    </div>
  );
}

function ConfirmForm({ title, action, submitLabel, onSuccess }: { title: string; action: string; submitLabel: string; onSuccess: (data: { recoveryCodes?: string[] }) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post<{ recoveryCodes?: string[] }>(action, { password, code });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setPassword("");
    setCode("");
    onSuccess(r.data);
  }
  return (
    <form onSubmit={submit} className={card}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {error && <div role="alert" className="rounded-md border border-stamp/30 bg-stamp/10 p-2 text-xs text-stamp">{error}</div>}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Passwort</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Code oder Wiederherstellungscode</span>
        <input type="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className={input} required />
      </label>
      <button type="submit" disabled={busy} className={primary}>{busy ? "…" : submitLabel}</button>
    </form>
  );
}

export function TwoFactorSettings({ enabledAt, recoveryCodesRemaining }: { enabledAt: string | null; recoveryCodesRemaining: number }) {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    const r = await post<Setup>("/api/account/totp/setup");
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSetup(r.data);
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post<{ recoveryCodes: string[] }>("/api/account/totp/enable", { password, code });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSetup(null);
    setPassword("");
    setCode("");
    setCodes(r.data.recoveryCodes);
  }

  function done() {
    setCodes(null);
    router.refresh();
  }

  if (codes) return <RecoveryCodeList codes={codes} onDone={done} />;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="max-w-md rounded-md border border-stamp/30 bg-stamp/10 p-2 text-xs text-stamp">{error}</div>}
      {enabledAt ? (
        <>
          <p className="text-sm text-ink-soft">
            Aktiv seit {new Date(enabledAt).toLocaleDateString("de-DE")}, {recoveryCodesRemaining} von 10 Wiederherstellungscodes unbenutzt.
          </p>
          <ConfirmForm title="Neue Wiederherstellungscodes" action="/api/account/totp/recovery-codes" submitLabel="Neue Codes erzeugen" onSuccess={(d) => setCodes(d.recoveryCodes ?? [])} />
          <ConfirmForm title="Abschalten" action="/api/account/totp/disable" submitLabel="Abschalten" onSuccess={() => router.refresh()} />
        </>
      ) : setup ? (
        <form onSubmit={enable} className={card}>
          <p className="text-sm text-ink-soft">Scanne den QR-Code mit deiner Authenticator-App oder tippe das Geheimnis ein.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- Data-URL, kein Optimierungsziel */}
          <img src={setup.qrDataUrl} alt="QR-Code für die Authenticator-App" width={240} height={240} />
          <p className="font-mono text-sm break-all" aria-label="Geheimnis">{groupFour(setup.secret)}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Passwort</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Code aus der App</span>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className={input} required />
          </label>
          <button type="submit" disabled={busy} className={primary}>{busy ? "…" : "Aktivieren"}</button>
        </form>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-ink-soft">Die Zwei-Faktor-Anmeldung ist nicht aktiv.</p>
          <button type="button" onClick={begin} disabled={busy} className={primary}>{busy ? "…" : "Einrichten"}</button>
        </div>
      )}
      <p className="text-xs text-ink-muted">API-Schlüssel sind von der Zwei-Faktor-Anmeldung nicht betroffen.</p>
    </div>
  );
}
