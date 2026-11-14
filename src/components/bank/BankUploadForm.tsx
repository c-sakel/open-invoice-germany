"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { BankImportResult, type BankImportResultView } from "./BankImportResult";

interface Reply {
  error?: string;
  code?: string;
  result?: BankImportResultView;
}

/** Datei waehlen -> Vorschau -> Import (dieselbe Datei). Die Datei selbst wird nie gespeichert. */
export function BankUploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<BankImportResultView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function send(mode: "preview" | "commit") {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("mode", mode);
      const res = await fetch("/api/bank-statements", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as Reply;
      if (data.result) setResult(data.result);
      else if (mode === "preview") setResult(null);
      if (res.status === 409 && data.code === "ALREADY_IMPORTED") {
        setMessage("Diese Datei wurde bereits importiert.");
      } else if (!res.ok) {
        setMessage(data.error ?? "Anfrage fehlgeschlagen.");
      } else if (mode === "commit") {
        router.refresh();
      }
    } catch {
      setMessage("Anfrage fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  function onPreview(e: FormEvent) {
    e.preventDefault();
    void send("preview");
  }

  const canCommit = result !== null && result.status === "preview" && result.duplicateOf === null && result.importedCount > 0;

  return (
    <div className="space-y-4">
      <form onSubmit={onPreview} className="flex flex-wrap items-end gap-3">
        <div className="text-sm">
          <label htmlFor="bank-file" className="mb-1 block font-medium text-ink-soft">
            Kontoauszug (CAMT.053 oder CAMT.054, XML)
          </label>
          <input
            id="bank-file"
            ref={fileInput}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="sr-only"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setMessage(null);
            }}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper"
            >
              Datei auswählen
            </button>
            <span className="text-ink-muted">{file ? file.name : "Keine Datei ausgewählt"}</span>
          </div>
        </div>
        <button
          type="submit"
          disabled={!file || busy}
          className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-50"
        >
          Vorschau prüfen
        </button>
        {canCommit && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void send("commit")}
            className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-50"
          >
            {result.importedCount} Umsätze importieren
          </button>
        )}
      </form>
      <div aria-live="polite" className="space-y-2">
        {message ? <p className="text-sm text-red-700">{message}</p> : null}
        {result ? <BankImportResult result={result} /> : null}
      </div>
    </div>
  );
}
