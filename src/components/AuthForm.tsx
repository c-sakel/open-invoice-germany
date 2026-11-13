"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
// "@/lib/brand-defaults" hat keine Imports (siehe dort) und ist deshalb im Gegensatz zu
// "@/domain/settings/brand" (zieht ueber branding.ts -> lib/db.ts den Prisma-Client nach
// sich) gefahrlos aus dieser "use client"-Datei importierbar. Der echte Wert kommt
// server-seitig ohnehin ueber die Prop (login/page.tsx ruft safeBrand()); dieser Default
// ist nur eine Typ-Absicherung fuer Aufrufer ohne Marke.
import { DEFAULT_APP_NAME, DEFAULT_APP_SHORT_NAME } from "@/lib/brand-defaults";

export function AuthForm({
  mode,
  redirectTo,
  appName = DEFAULT_APP_NAME,
  appShortName = DEFAULT_APP_SHORT_NAME,
  hasAppLogo = false,
}: {
  mode: "login" | "setup";
  redirectTo: string;
  /** Marke fuer den Login-Text; Default fuer den Setup-Zweig (dort gibt es noch keine Organisation). */
  appName?: string;
  appShortName?: string;
  hasAppLogo?: boolean;
}) {
  const router = useRouter();
  const isSetup = mode === "setup";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Fehler");
      setBusy(false);
      return;
    }
    const j = (await res.json().catch(() => ({}))) as { twoFactor?: boolean };
    if (!isSetup && j.twoFactor) {
      router.push(`/login/zweiter-faktor?from=${encodeURIComponent(redirectTo)}`);
      return;
    }
    router.push(redirectTo);
    router.refresh();
  }

  const input = "rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";

  return (
    <div className="mx-auto max-w-sm">
      {/* Markenzeile (B14): Logo bzw. Kuerzel-Kachel + Name wie in der Topbar, ueber der Karte. */}
      <div className="mb-8 flex items-center justify-center gap-2 font-semibold tracking-tight">
        {hasAppLogo ? (
          // eslint-disable-next-line @next/next/no-img-element -- Route liefert dynamisch aus der DB
          <img src="/api/branding/appLogo" alt={appName} className="h-9 w-auto" />
        ) : (
          <>
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-md bg-pen text-base font-bold text-on-accent">{appShortName}</span>
            <span className="text-lg">{appName}</span>
          </>
        )}
      </div>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{isSetup ? "Konto einrichten" : "Anmelden"}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {isSetup ? "Lege dein Admin-Konto an. Es ist der einzige Zugang zu deiner Instanz." : `Melde dich an deiner ${appName}-Instanz an.`}
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-card)] bg-sheet p-6 shadow-[var(--shadow-card)]">
        {error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{error}</div>}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">E-Mail</span>
          <input className={input} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Passwort</span>
          <input
            className={input}
            type="password"
            autoComplete={isSetup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isSetup ? 8 : undefined}
          />
          {isSetup && <span className="text-xs text-ink-muted">Mindestens 8 Zeichen.</span>}
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-pen px-4 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60"
        >
          {busy ? "…" : isSetup ? "Konto erstellen" : "Anmelden"}
        </button>
        {!isSetup && (
          <p className="text-center text-sm">
            <Link href="/login/passwort-vergessen" className="text-pen hover:underline">Passwort vergessen?</Link>
          </p>
        )}
      </form>
    </div>
  );
}
