"use client";

import { useState } from "react";
import Link from "next/link";

/** Passwort-Reset anfordern: immer dieselbe Antwort, unabhaengig davon, ob das Konto existiert. */
export function PasswordResetRequestForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    setBusy(false);
    if (!res.ok) {
      setError(j.error ?? "Anfrage fehlgeschlagen.");
      return;
    }
    setMessage(j.message ?? "Anfrage gesendet.");
  }

  const input = "rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";
  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Passwort vergessen</h1>
        <p className="mt-1 text-sm text-ink-muted">Wir schicken dir einen Link zum Zurücksetzen per E-Mail.</p>
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-card)] bg-sheet p-6 shadow-[var(--shadow-card)]">
        {error && <div role="alert" className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{error}</div>}
        {message ? (
          <div role="status" className="rounded-md border border-rule-strong p-3 text-sm">{message}</div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">E-Mail</span>
              <input className={input} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <button type="submit" disabled={busy} className="w-full rounded-md bg-pen px-4 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
              {busy ? "…" : "Link anfordern"}
            </button>
          </>
        )}
        <p className="text-center text-sm"><Link href="/login" className="text-ink-muted hover:underline">Zurück zur Anmeldung</Link></p>
      </form>
    </div>
  );
}
