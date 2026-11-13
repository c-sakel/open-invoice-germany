"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { safeRedirectPath } from "@/lib/http/safe-redirect";

/** Zweiter Schritt der Anmeldung: Code aus der Authenticator-App oder Wiederherstellungscode. */
export function SecondFactorForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/second-factor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Fehler");
      setBusy(false);
      return;
    }
    router.push(safeRedirectPath(redirectTo));
    router.refresh();
  }

  const input = "rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";

  return (
    <div className="mx-auto max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Zweiter Faktor</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {recovery ? "Gib einen deiner Wiederherstellungscodes ein. Jeder Code gilt nur einmal." : "Gib den 6-stelligen Code aus deiner Authenticator-App ein."}
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-card)] bg-sheet p-6 shadow-[var(--shadow-card)]">
        {error && <div role="alert" className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{error}</div>}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">{recovery ? "Wiederherstellungscode" : "Code"}</span>
          <input
            className={input}
            type="text"
            inputMode={recovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy} className="w-full rounded-md bg-pen px-4 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          {busy ? "…" : "Anmelden"}
        </button>
        <button type="button" onClick={() => { setRecovery(!recovery); setCode(""); setError(null); }} className="w-full text-center text-sm text-pen hover:underline">
          {recovery ? "Code aus der App verwenden" : "Wiederherstellungscode verwenden"}
        </button>
        <p className="text-center text-sm"><Link href="/login" className="text-ink-muted hover:underline">Zurück zur Anmeldung</Link></p>
      </form>
    </div>
  );
}
