"use client";

import { useActionState, useState } from "react";
import { saveEmailTemplateAction } from "@/app/actions/templates";
import type { ActionResult } from "@/app/actions/result";
import { EMAIL_DOC_TYPES, type EmailDocType } from "@/schemas/email";
import { DOC_TYPE_LABEL } from "@/lib/email/doc-type-labels";
import { DOC_LANGUAGES, DOC_LANGUAGE_LABEL, type DocLanguage } from "@/lib/i18n/doc";
import { TEMPLATE_PLACEHOLDERS } from "@/lib/template/placeholders";
import { TextField, SelectField, CheckboxField, SubmitButton, ErrorBanner } from "./fields";

export interface EmailTemplateFormData {
  id?: string;
  name: string;
  docType: EmailDocType;
  language?: string;
  subject: string;
  body: string;
  signature: string | null;
  isDefault: boolean;
}

export function EmailTemplateForm({
  template,
  customFieldPlaceholders = [],
}: {
  template?: EmailTemplateFormData | null;
  /** Fix-Welle B1: dynamische {{customField.<key>}}-Platzhalter (§31), vom Aufrufer geladen. */
  customFieldPlaceholders?: { path: string; label: string }[];
}) {
  const [state, action] = useActionState<ActionResult, FormData>(saveEmailTemplateAction, { ok: false });
  const [docType, setDocType] = useState<EmailDocType>(template?.docType ?? "INVOICE");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [signature, setSignature] = useState(template?.signature ?? "");
  const [preview, setPreview] = useState<{ subject: string; body: string; warnings: string[] } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  async function loadPreview() {
    setPreviewBusy(true);
    try {
      const res = await fetch("/api/emails/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docType, subject, body, signature, sample: true }),
      });
      const j = await res.json();
      if (res.ok) setPreview(j);
      else setPreview({ subject: "", body: j.error ?? "Fehler", warnings: [] });
    } finally {
      setPreviewBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <form action={action} className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 lg:col-span-2">
        <ErrorBanner message={state.error} />
        {state.ok && <p className="text-sm text-ledger">Vorlage gespeichert.</p>}
        {template?.id && <input type="hidden" name="id" value={template.id} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" name="name" defaultValue={template?.name} required />
          {template?.id ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-soft">Dokumenttyp</span>
              <input
                type="text"
                value={DOC_TYPE_LABEL[docType]}
                disabled
                readOnly
                className="rounded-md border border-rule-strong bg-well px-3 py-2 text-sm text-ink-soft"
              />
              <input type="hidden" name="docType" value={docType} />
              <span className="text-xs text-ink-muted">Der Dokumenttyp kann nach dem Anlegen nicht mehr geändert werden.</span>
            </label>
          ) : (
            <SelectField
              label="Dokumenttyp"
              name="docType"
              defaultValue={docType}
              options={EMAIL_DOC_TYPES.map((t) => ({ value: t, label: DOC_TYPE_LABEL[t] }))}
              onChange={(e) => setDocType(e.target.value as EmailDocType)}
            />
          )}
        </div>

        {template?.id ? (
          <>
            <input type="hidden" name="language" value={template.language ?? "de"} />
            <p className="text-sm text-ink-soft">
              Sprache: <strong>{DOC_LANGUAGE_LABEL[(template.language === "en" ? "en" : "de") as DocLanguage]}</strong> (nach dem Anlegen nicht mehr änderbar)
            </p>
          </>
        ) : (
          <SelectField
            label="Sprache"
            name="language"
            defaultValue="de"
            options={DOC_LANGUAGES.map((l) => ({ value: l, label: DOC_LANGUAGE_LABEL[l] }))}
            hint="Die Vorlage wird für Belege in dieser Sprache vorgeschlagen."
          />
        )}

        <TextField label="Betreff" name="subject" defaultValue={subject} required onChange={(e) => setSubject(e.target.value)} />

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">
            Nachricht<span className="text-stamp"> *</span>
          </span>
          <textarea
            rows={12}
            name="body"
            required
            className="w-full rounded-md border border-rule-strong px-3 py-2 text-sm font-mono focus:border-pen"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Nachrichtentext mit Platzhaltern, z. B. {{document.number}}"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Signatur</span>
          <textarea
            rows={3}
            name="signature"
            className="rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
          />
        </label>

        <CheckboxField label="Als Standard für diesen Dokumenttyp verwenden" name="isDefault" defaultChecked={template?.isDefault} />

        <div className="flex items-center gap-3">
          <SubmitButton>Vorlage speichern</SubmitButton>
          <button type="button" onClick={loadPreview} disabled={previewBusy} className="rounded-md border border-rule-strong bg-sheet px-3 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60">
            {previewBusy ? "…" : "Vorschau"}
          </button>
        </div>

        {preview && (
          <div className="space-y-2 rounded-md border border-rule bg-paper p-3 text-sm">
            <p className="font-medium text-ink">Betreff: {preview.subject}</p>
            <pre className="whitespace-pre-wrap font-sans text-ink-soft">{preview.body}</pre>
            {preview.warnings.length > 0 && (
              <div className="rounded-md border border-seal/30 bg-seal/10 p-2 text-xs text-seal">
                {preview.warnings.join(", ")}
              </div>
            )}
          </div>
        )}
      </form>

      <aside className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
        <h3 className="font-semibold text-ink">Platzhalter</h3>
        <ul className="space-y-1">
          {[...TEMPLATE_PLACEHOLDERS, ...customFieldPlaceholders].map((p) => (
            <li key={p.path} className="flex items-center justify-between gap-2">
              <code className="rounded bg-well px-1.5 py-0.5 text-xs">{`{{${p.path}}}`}</code>
              <span className="text-xs text-ink-muted">{p.label}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
