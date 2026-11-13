"use client";

import { useState } from "react";
import Link from "next/link";

/** Neues Passwort festlegen; bei aktiver Zwei-Faktor-Anmeldung zusaetzlich mit Code. */
export function PasswordResetConfirmForm({ token, requiresSecondFactor }: { token: string; requiresSecondFactor: boolean }) {
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordRepeat, setNewPasswordRepeat] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword, newPasswordRepeat, ...(requiresSecondFactor ? { code } : {}) }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Passwort konnte nicht zurückgesetzt werden.");
      return;
    }
    setNewPassword("");
    setNewPasswordRepeat("");
    setCode("");
    setDone(true);
  }

  const input = "rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";
  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Neues Passwort</h1>
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-card)] bg-sheet p-6 shadow-[var(--shadow-card)]">
        {error && <div role="alert" className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{error}</div>}
        {done ? (
          <>
            <div role="status" className="rounded-md border border-rule-strong p-3 text-sm">
              Dein Passwort wurde geändert. Alle bestehenden Sitzungen sind beendet.
            </div>
            <p className="text-center text-sm"><Link href="/login" className="text-pen hover:underline">Zur Anmeldung</Link></p>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Neues Passwort (mind. 10 Zeichen)</span>
              <input className={input} type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Wiederholung</span>
              <input className={input} type="password" autoComplete="new-password" value={newPasswordRepeat} onChange={(e) => setNewPasswordRepeat(e.target.value)} required />
            </label>
            {requiresSecondFactor && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Code oder Wiederherstellungscode</span>
                <input className={input} type="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
              </label>
            )}
            <button type="submit" disabled={busy} className="w-full rounded-md bg-pen px-4 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
              {busy ? "…" : "Passwort festlegen"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
