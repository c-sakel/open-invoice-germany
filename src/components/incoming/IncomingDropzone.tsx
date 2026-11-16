"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { classifyUploadReply, planUploads, validationLabel, MAX_UPLOAD_FILES, type UploadOutcome } from "./incoming-ui";

interface Entry {
  name: string;
  state: "wartet" | "läuft" | "fertig";
  outcome?: UploadOutcome;
}

/** Ablagefeld: mehrere Dateien (höchstens 20), eine nach der anderen an die Annahme; Ergebnis je Datei. */
export function IncomingDropzone() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  async function upload(list: File[]) {
    const plan = planUploads(list);
    if (!plan.ok) {
      setMessage(plan.error);
      return;
    }
    setMessage(null);
    setBusy(true);
    setEntries(plan.files.map((f) => ({ name: f.name, state: "wartet" })));
    const patch = (i: number, e: Partial<Entry>) => setEntries((cur) => cur.map((x, j) => (j === i ? { ...x, ...e } : x)));
    try {
      for (let i = 0; i < plan.files.length; i++) {
        patch(i, { state: "läuft" });
        let outcome: UploadOutcome;
        try {
          const body = new FormData();
          body.set("file", plan.files[i]);
          const res = await fetch("/api/incoming-invoices", { method: "POST", body });
          outcome = classifyUploadReply(res.status, await res.json().catch(() => ({})));
        } catch {
          outcome = { kind: "rejected", text: "Anfrage fehlgeschlagen." };
        }
        patch(i, { state: "fertig", outcome });
      }
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  function pick(files: FileList | null) {
    if (files && files.length > 0) void upload(Array.from(files));
    if (input.current) input.current.value = "";
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    if (!busy) pick(e.dataTransfer.files);
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`rounded-md border border-dashed px-4 py-6 text-center text-sm ${over ? "border-pen bg-pen/10" : "border-rule-strong bg-paper"}`}
      >
        <p className="text-ink-soft">Rechnungsdateien hier ablegen (XML, PDF, PNG, JPEG; höchstens {MAX_UPLOAD_FILES} Dateien, je bis 15 MB).</p>
        <input
          id="incoming-files"
          ref={input}
          type="file"
          multiple
          accept=".xml,.pdf,.png,.jpg,.jpeg,text/xml,application/xml,application/pdf,image/png,image/jpeg"
          className="sr-only"
          onChange={(e) => pick(e.target.files)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="mt-3 rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-50"
        >
          Dateien auswählen
        </button>
      </div>
      <div aria-live="polite" className="space-y-2">
        {message ? <p className="text-sm text-red-700">{message}</p> : null}
        {entries.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label="Ergebnis je Datei">
            {entries.map((e, i) => (
              <li key={`${i}-${e.name}`} className="rounded-md border border-rule bg-paper px-3 py-2">
                <span className="font-medium text-ink break-all">{e.name}</span>
                <span className="text-ink-soft"> — </span>
                <OutcomeText entry={e} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OutcomeText({ entry }: { entry: Entry }) {
  const o = entry.outcome;
  if (!o) return <span className="text-ink-muted">{entry.state === "läuft" ? "wird übertragen …" : "wartet"}</span>;
  switch (o.kind) {
    case "accepted":
      return (
        <span>
          angenommen{o.number ? ` (${o.number})` : ""}, Prüfung: {validationLabel(o.validationStatus)}.{" "}
          <Link href={`/eingang/${o.id}`} className="underline">
            Öffnen
          </Link>
        </span>
      );
    case "possible-duplicate":
      return (
        <span>
          angenommen, aber möglicherweise eine Dublette von{" "}
          <Link href={`/eingang/${o.duplicateOfId}`} className="underline">
            diesem Eingang
          </Link>
          .{" "}
          <Link href={`/eingang/${o.id}`} className="underline">
            Öffnen
          </Link>
        </span>
      );
    case "already-present":
      return (
        <span>
          bereits vorhanden.{" "}
          <Link href={`/eingang/${o.id}`} className="underline">
            Zum vorhandenen Eingang
          </Link>
        </span>
      );
    case "rejected":
      return <span className="text-red-700">abgelehnt: {o.text}</span>;
  }
}
