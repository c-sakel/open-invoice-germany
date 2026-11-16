"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import { handoverErrorText } from "./incoming-ui";

interface Props {
  defaultFrom: string;
  defaultTo: string;
}

/** Übergabe an die Buchhaltung: Zeitraum wählen, ZIP mit Originalen und Tabelle laden. Ohne Notizen. */
export function IncomingHandoverForm({ defaultFrom, defaultTo }: Props) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to, includeRejected: includeRejected ? "true" : "false" });
      // Fehler (Zeitraum zu gross, Eingabe) vorab pruefen; das ZIP selbst laedt der Browser per Direktlink,
      // ohne es im Arbeitsspeicher der Seite zu halten.
      const check = await fetch(`/api/incoming-invoices/export?${qs.toString()}&dryRun=1`, { credentials: "same-origin" });
      if (!check.ok) {
        let body: unknown = null;
        try {
          body = await check.json();
        } catch {
          /* feste Meldung */
        }
        setError(handoverErrorText(body, "Die Übergabe konnte nicht erstellt werden."));
        return;
      }
      const a = document.createElement("a");
      a.href = `/api/incoming-invoices/export?${qs.toString()}`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError("Die Übergabe konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-md border border-rule bg-paper p-4 text-sm">
      <summary className="cursor-pointer font-medium text-ink">Übergabe an die Buchhaltung</summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void download();
        }}
      >
        <p className="text-xs text-ink-muted">ZIP mit den Originaldateien und einer Tabelle, nach Eingangsdatum. Interne Notizen sind nie enthalten. Höchstens 2.000 Belege und 500 MB je Zeitraum.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Von</span>
            <input type="date" className={inputCls} required value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink-soft">Bis</span>
            <input type="date" className={inputCls} required value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeRejected} onChange={(e) => setIncludeRejected(e.target.checked)} />
          <span>Abgelehnte einschließen</span>
        </label>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Wird erstellt …" : "Übergabe herunterladen"}
        </Button>
        <p role="alert" className={error ? "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900" : "sr-only"}>
          {error}
        </p>
      </form>
    </details>
  );
}
