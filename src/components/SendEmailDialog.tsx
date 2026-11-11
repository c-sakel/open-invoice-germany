"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EmailDocType } from "@/schemas/email";

interface PrefillResult {
  docType: EmailDocType;
  docId: string;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  signature: string;
  copyToSelf: boolean;
  attachments: { filename: string; size: number }[];
  // eInvoiceDefault (Phase 7, §33): Dateinamen, die beim Oeffnen vorausgewaehlt sind.
  defaultStandardAttachments: string[];
  // Beleganhaenge (Phase 4b) — zusaetzlich zu den Standardanhaengen waehlbar, per
  // attachmentIds im Payload (src/schemas/email.ts, sendEmailInputSchema.attachmentIds).
  documentAttachments: { id: string; filename: string; sizeBytes: number }[];
  warnings: string[];
  templateId?: string;
  resendOfId?: string;
  templates: { id: string; name: string }[];
}

function join(list: string[]): string {
  return list.join(", ");
}
function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function SendEmailDialog({
  docType,
  docId,
  label,
  resendLogId,
  autoOpen,
  hideTrigger,
}: {
  docType: EmailDocType;
  docId: string;
  label?: string;
  resendLogId?: string;
  /** Phase 8b Fix-Runde 1 (§41, Ruling a): oeffnet den Dialog automatisch beim Mounten
   *  (z. B. RowActionsMenu REMINDER — Mahnung erst anlegen, dann direkt den Versand-
   *  Dialog dafuer oeffnen, ohne einen zweiten Klick zu verlangen). Nur einmal pro Mount
   *  wirksam — der Aufrufer erzwingt einen Remount ueber einen wechselnden `key`. */
  autoOpen?: boolean;
  /** Blendet den eigenen Trigger-Button aus (nur bei `autoOpen` sinnvoll). */
  hideTrigger?: boolean;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [loading, setLoading] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<PrefillResult | null>(null);

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [signature, setSignature] = useState("");
  const [copyToSelf, setCopyToSelf] = useState(false);
  const [selectedStandard, setSelectedStandard] = useState<Set<string>>(new Set());
  const [selectedDocAttachments, setSelectedDocAttachments] = useState<Set<string>>(new Set());
  const [extraFiles, setExtraFiles] = useState<File[]>([]);

  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  function applyPrefill(pre: PrefillResult) {
    setData(pre);
    setTo(join(pre.to));
    setCc(join(pre.cc));
    setBcc(join(pre.bcc));
    setTemplateId(pre.templateId ?? "");
    setSubject(pre.subject);
    setBody(pre.body);
    setSignature(pre.signature);
    setCopyToSelf(pre.copyToSelf);
    setSelectedStandard(new Set(pre.defaultStandardAttachments));
    setSelectedDocAttachments(new Set());
    setPreview(null);
  }

  async function loadPrefill(withTemplateId?: string) {
    setLoading(true);
    setLoadError(null);
    setNotConfigured(false);
    try {
      const params = new URLSearchParams();
      if (resendLogId && !withTemplateId) {
        params.set("logId", resendLogId);
      } else {
        params.set("docType", docType);
        params.set("docId", docId);
        if (withTemplateId) params.set("templateId", withTemplateId);
      }
      const res = await fetch(`/api/emails/prefill?${params.toString()}`);
      const j = await res.json();
      if (res.status === 409) {
        setNotConfigured(true);
        return;
      }
      if (!res.ok) {
        setLoadError(j.error ?? "Vorbelegung fehlgeschlagen.");
        return;
      }
      applyPrefill(j);
    } catch {
      setLoadError("Vorbelegung fehlgeschlagen.");
    } finally {
      setLoading(false);
    }
  }

  async function open() {
    dialogRef.current?.showModal();
    setSendError(null);
    await loadPrefill();
  }

  function close() {
    dialogRef.current?.close();
  }

  // Ruling (a): einmalig beim Mounten oeffnen, wenn autoOpen gesetzt ist — kein
  // zusaetzlicher Klick auf den Trigger noetig. Ueber setTimeout entkoppelt (statt
  // direktem setState-Aufruf im Effekt-Koerper — react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!autoOpen) return;
    const t = setTimeout(() => void open(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onTemplateChange(id: string) {
    setTemplateId(id);
    void loadPrefill(id || undefined);
  }

  function toggleStandard(filename: string) {
    setSelectedStandard((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }

  function toggleDocAttachment(id: string) {
    setSelectedDocAttachments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function doPreview() {
    const res = await fetch("/api/emails/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType, docId, subject, body, signature }),
    });
    const j = await res.json();
    if (res.ok) setPreview(j);
    else setSendError(j.error ?? "Vorschau fehlgeschlagen.");
  }

  async function doSend() {
    setSendBusy(true);
    setSendError(null);
    try {
      const payload = {
        docType,
        docId,
        // addressListSchema erwartet den rohen, kommagetrennten Text (nicht das Array).
        to,
        cc,
        bcc,
        subject,
        body,
        signature,
        copyToSelf,
        standardAttachments: Array.from(selectedStandard),
        attachmentIds: Array.from(selectedDocAttachments),
        templateId: templateId || undefined,
        resendOfId: resendLogId,
        // Warnungen aus der Vorbelegung (z. B. unbekannte Platzhalter) mitschicken, damit
        // sie im EmailLog protokolliert werden (G3).
        warnings: data?.warnings ?? [],
      };
      const fd = new FormData();
      fd.set("payload", JSON.stringify(payload));
      for (const f of extraFiles) fd.append("files", f);

      const res = await fetch("/api/emails/send", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) {
        if (j.error === "MAIL_NOT_CONFIGURED") setNotConfigured(true);
        else setSendError(j.error ?? "Versand fehlgeschlagen.");
        return;
      }
      if (j.status === "FAILED") {
        setSendError(j.error ?? "Versand fehlgeschlagen.");
        return;
      }
      close();
      router.refresh();
    } catch {
      setSendError("Versand fehlgeschlagen.");
    } finally {
      setSendBusy(false);
    }
  }

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={open}
          className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper"
        >
          {label ?? "Per E-Mail senden"}
        </button>
      )}

      <dialog ref={dialogRef} className="w-full max-w-2xl rounded-lg border border-rule p-0 backdrop:bg-ink/40">
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">{resendLogId ? "E-Mail erneut senden" : "E-Mail senden"}</h2>
            <button type="button" onClick={close} className="text-ink-muted hover:text-ink-soft">
              ✕
            </button>
          </div>

          {loading && <p className="text-sm text-ink-muted">Lade Vorbelegung…</p>}

          {notConfigured && (
            <div className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
              Für diese Organisation sind keine Mail-Einstellungen hinterlegt.{" "}
              <a href="/einstellungen/email" className="font-medium underline">
                Jetzt einrichten
              </a>
            </div>
          )}

          {loadError && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{loadError}</div>}

          {data && !notConfigured && (
            <div className="space-y-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Von</span>
                <input readOnly value={`${data.from.name} <${data.from.address}>`} className="rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink-muted" />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">An</span>
                <input value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink-soft">CC</span>
                  <input value={cc} onChange={(e) => setCc(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink-soft">BCC</span>
                  <input value={bcc} onChange={(e) => setBcc(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
                </label>
              </div>

              {data.templates.length > 0 && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-ink-soft">Vorlage</span>
                  <select value={templateId} onChange={(e) => onTemplateChange(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm">
                    <option value="">— keine —</option>
                    {data.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Betreff</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Nachricht</span>
                <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Signatur</span>
                <textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} className="rounded-md border border-rule-strong px-3 py-2 text-sm" />
              </label>

              {data.attachments.length > 0 && (
                <div className="space-y-1 text-sm">
                  <span className="font-medium text-ink-soft">Standardanhänge</span>
                  {data.attachments.map((a) => (
                    <label key={a.filename} className="flex items-center gap-2">
                      <input type="checkbox" checked={selectedStandard.has(a.filename)} onChange={() => toggleStandard(a.filename)} className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" />
                      <span>
                        {a.filename} <span className="text-xs text-ink-muted">({formatKb(a.size)})</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {data.documentAttachments.length > 0 && (
                <div className="space-y-1 text-sm">
                  <span className="font-medium text-ink-soft">Beleganhänge</span>
                  {data.documentAttachments.map((a) => (
                    <label key={a.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedDocAttachments.has(a.id)}
                        onChange={() => toggleDocAttachment(a.id)}
                        className="h-4 w-4 rounded border-rule-strong"
                      />
                      <span>
                        {a.filename} <span className="text-xs text-ink-muted">({formatKb(a.sizeBytes)})</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Zusatzdateien</span>
                <input type="file" multiple onChange={(e) => setExtraFiles(Array.from(e.target.files ?? []))} className="text-sm" />
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={copyToSelf} onChange={(e) => setCopyToSelf(e.target.checked)} className="h-4 w-4 rounded-[var(--radius-control)] border-rule-strong" />
                <span className="font-medium text-ink-soft">Kopie an mich</span>
              </label>

              {data.warnings.length > 0 && (
                <div className="rounded-md border border-seal/30 bg-seal/10 p-2 text-xs text-seal">{data.warnings.join(", ")}</div>
              )}

              {preview && (
                <div className="space-y-1 rounded-md border border-rule bg-paper p-3 text-sm">
                  <p className="font-medium text-ink">Betreff: {preview.subject}</p>
                  <pre className="whitespace-pre-wrap font-sans text-ink-soft">{preview.body}</pre>
                </div>
              )}

              {sendError && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{sendError}</div>}

              <div className="flex items-center gap-3 pt-2">
                <button type="button" onClick={doPreview} className="rounded-md border border-rule-strong bg-sheet px-3 py-2 text-sm font-medium text-ink-soft hover:bg-paper">
                  Vorschau
                </button>
                <button type="button" onClick={doSend} disabled={sendBusy} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
                  {sendBusy ? "Sende…" : "Senden"}
                </button>
                <button type="button" onClick={close} className="text-sm text-ink-muted hover:text-ink">
                  Abbrechen
                </button>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
