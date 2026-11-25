"use client";

/** Letzte Fehlergrenze (ersetzt das Root-Layout): eigenes <html>, nur feste Texte und der digest. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="de">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <div role="alert">
          <h1 style={{ fontSize: "1.125rem" }}>Die Seite konnte nicht geladen werden.</h1>
          {error.digest && <p style={{ fontSize: "0.75rem", color: "#666" }}>Fehlerkennung: {error.digest}</p>}
          <button type="button" onClick={() => reset()} style={{ marginRight: "1rem" }}>
            Erneut versuchen
          </button>
          {/* Absichtlich <a>: global-error ersetzt das Root-Layout, der Router ist hier nicht verfügbar. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">Zur Übersicht</a>
        </div>
      </body>
    </html>
  );
}
