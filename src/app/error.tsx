"use client";

import Link from "next/link";

/** Fehlergrenze je Segment: nur feste Texte und der digest, nie `error.message`. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="space-y-3 py-10">
      <h1 className="text-lg font-semibold text-ink">Die Seite konnte nicht geladen werden.</h1>
      {error.digest && <p className="text-xs text-ink-muted">Fehlerkennung: {error.digest}</p>}
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => reset()} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
          Erneut versuchen
        </button>
        <Link href="/" className="text-sm text-ink-soft underline-offset-2 hover:underline">
          Zur Übersicht
        </Link>
      </div>
    </div>
  );
}
