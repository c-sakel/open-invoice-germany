"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

interface RowError {
  line: number;
  column: string | null;
  message: string;
}
interface Preview {
  fileHash: string;
  encoding: string;
  delimiter: string;
  totalRows: number;
  validRows: number;
  errorCount: number;
  errors: RowError[];
  ignoredColumns: string[];
  sample?: { line: number; values: Record<string, string> }[];
}
interface Reply {
  error?: string;
  created?: number;
  preview?: Preview;
}

/** Datei waehlen -> Vorschau -> Import (dieselbe Datei, an die Vorschau gebunden). Keine Datei wird gespeichert. */
export function CsvImportForm({ resource, noun, listHref }: { resource: "contacts" | "products"; noun: string; listHref: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(mode: "preview" | "commit") {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("mode", mode);
      if (mode === "commit" && preview) body.set("expectedHash", preview.fileHash);
      const res = await fetch(`/api/imports/${resource}`, { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as Reply;
      if (data.preview) setPreview(data.preview);
      else if (mode === "preview") setPreview(null);
      if (res.status === 201 && typeof data.created === "number") {
        setCreated(data.created);
      } else if (!res.ok) {
        setMessage(data.error ?? "Anfrage fehlgeschlagen.");
      }
    } catch {
      setMessage("Anfrage fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  function onPreview(e: FormEvent) {
    e.preventDefault();
    setCreated(null);
    void send("preview");
  }

  const sampleColumns = preview?.sample?.[0] ? Object.keys(preview.sample[0].values) : [];

  return (
    <div className="space-y-5">
      <form onSubmit={onPreview} className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-soft">CSV-Datei</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setCreated(null);
              setMessage(null);
            }}
            className="block text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={!file || busy}
          className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-50"
        >
          Vorschau prüfen
        </button>
      </form>

      <div aria-live="polite" className="space-y-1 text-sm">
        {message ? <p className="text-red-700">{message}</p> : null}
        {created !== null ? (
          <p className="font-medium text-ink">
            {created} {noun} angelegt.{" "}
            <Link href={listHref} className="underline">
              Zur Liste
            </Link>
          </p>
        ) : null}
      </div>

      {preview && created === null ? (
        <section className="space-y-4">
          <p className="text-sm text-ink-soft">
            {preview.totalRows} Zeilen, {preview.validRows} gültig, {preview.errorCount} Fehler · Kodierung {preview.encoding} · Trennzeichen „{preview.delimiter}“
            {preview.ignoredColumns.length > 0 ? ` · ignorierte Spalten: ${preview.ignoredColumns.join(", ")}` : ""}
          </p>

          {preview.errors.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="pb-2 text-left font-medium text-ink">Fehler (höchstens 200 angezeigt)</caption>
                <thead>
                  <tr className="border-b border-rule-strong">
                    <th scope="col" className="py-1 pr-4">Zeile</th>
                    <th scope="col" className="py-1 pr-4">Spalte</th>
                    <th scope="col" className="py-1">Meldung</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.errors.map((r, i) => (
                    <tr key={`${r.line}-${i}`} className="border-b border-rule">
                      <td className="py-1 pr-4">{r.line}</td>
                      <td className="py-1 pr-4">{r.column ?? "–"}</td>
                      <td className="py-1">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {preview.sample && preview.sample.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="pb-2 text-left text-sm font-medium text-ink">Beispielzeilen (die ersten {preview.sample.length})</caption>
                <thead>
                  <tr className="border-b border-rule-strong">
                    <th scope="col" className="py-1 pr-3">Zeile</th>
                    {sampleColumns.map((c) => (
                      <th key={c} scope="col" className="py-1 pr-3">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r) => (
                    <tr key={r.line} className="border-b border-rule">
                      <td className="py-1 pr-3">{r.line}</td>
                      {sampleColumns.map((c) => (
                        <td key={c} className="py-1 pr-3">{r.values[c] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {preview.errorCount === 0 && preview.validRows > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void send("commit")}
              className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-50"
            >
              {preview.validRows} {noun} importieren
            </button>
          ) : (
            <p className="text-sm text-ink-muted">Importieren ist erst möglich, wenn die Datei keine Fehler mehr enthält.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
