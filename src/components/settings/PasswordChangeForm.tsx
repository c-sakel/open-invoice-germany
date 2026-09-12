"use client";

import { useState } from "react";

/**
 * Passwort aendern (Phase 14a, Task 9, R12) — drei Felder, deutsche Fehlermeldungen,
 * Erfolgsmeldung mit Hinweis auf beendete Sitzungen (Plan-Vorgabe). POST /api/auth/password
 * nutzt dieselbe Session (kein separates Login noetig) — bei Erfolg bleibt NUR diese
 * Sitzung angemeldet, alle anderen Browser/Geraete werden beim naechsten Zugriff abgemeldet.
 */
export function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordRepeat, setNewPasswordRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword, newPasswordRepeat }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Passwort konnte nicht geändert werden.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setNewPasswordRepeat("");
    setDone(true);
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-3 rounded-lg border border-slate-200 bg-white p-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Aktuelles Passwort</span>
        <input
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Neues Passwort</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Neues Passwort wiederholen</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={newPasswordRepeat}
          onChange={(e) => setNewPasswordRepeat(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2"
          required
        />
      </label>
      <p className="text-xs text-slate-500">Mindestens 10 Zeichen. Nach dem Ändern werden alle anderen angemeldeten Sitzungen sofort beendet — nur dieser Browser bleibt angemeldet.</p>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">{error}</div>}
      {done && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">Passwort geändert. Andere angemeldete Sitzungen wurden beendet.</div>}
      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={busy} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "…" : "Passwort ändern"}
        </button>
      </div>
    </form>
  );
}
