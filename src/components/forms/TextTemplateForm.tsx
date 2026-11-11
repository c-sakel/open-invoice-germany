"use client";

import { useActionState, useState } from "react";
import { saveTextTemplateAction } from "@/app/actions/text-templates";
import type { ActionResult } from "@/app/actions/result";
import { DOC_TYPE_LABEL } from "@/lib/email/doc-type-labels";
import type { EmailDocType } from "@/schemas/email";
import { TextField, SelectField, CheckboxField, SubmitButton, ErrorBanner } from "./fields";

const DOC_TYPES: EmailDocType[] = ["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA", "DELIVERY_NOTE", "INVOICE"];
const POSITIONS = [
  { value: "HEAD", label: "Kopftext" },
  { value: "FOOT", label: "Fußtext" },
  { value: "TERMS_DELIVERY", label: "Lieferbedingungen" },
  { value: "TERMS_PAYMENT", label: "Zahlungsbedingungen" },
] as const;

export interface TextTemplateFormData {
  id?: string;
  name: string;
  docType: EmailDocType;
  position: string;
  body: string;
  isDefault: boolean;
}

export function TextTemplateForm({
  template,
  customFieldPlaceholders = [],
}: {
  template?: TextTemplateFormData | null;
  /** Fix-Welle B1: dynamische {{customField.<key>}}-Platzhalter (§31), vom Aufrufer geladen. */
  customFieldPlaceholders?: { path: string; label: string }[];
}) {
  const [state, action] = useActionState<ActionResult, FormData>(saveTextTemplateAction, { ok: false });
  const [docType, setDocType] = useState<EmailDocType>(template?.docType ?? "ANGEBOT");
  const [body, setBody] = useState(template?.body ?? "");
  const [preview, setPreview] = useState<{ body: string; warnings: string[] } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  async function loadPreview() {
    setPreviewBusy(true);
    try {
      const res = await fetch("/api/emails/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docType, subject: "", body, signature: "", sample: true }),
      });
      const j = await res.json();
      if (res.ok) setPreview({ body: j.body, warnings: j.warnings });
      else setPreview({ body: j.error ?? "Fehler", warnings: [] });
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
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-ink-soft">Dokumenttyp / Position</span>
                <input
                  type="text"
                  value={`${DOC_TYPE_LABEL[docType]} — ${POSITIONS.find((p) => p.value === template.position)?.label ?? template.position}`}
                  disabled
                  readOnly
                  className="rounded-md border border-rule-strong bg-well px-3 py-2 text-sm text-ink-muted"
                />
                <span className="text-xs text-ink-muted">Dokumenttyp und Position koennen nach dem Anlegen nicht mehr geaendert werden.</span>
              </label>
              <input type="hidden" name="docType" value={docType} />
              <input type="hidden" name="position" value={template.position} />
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <SelectField
                label="Dokumenttyp"
                name="docType"
                defaultValue={docType}
                options={DOC_TYPES.map((t) => ({ value: t, label: DOC_TYPE_LABEL[t] }))}
                onChange={(e) => setDocType(e.target.value as EmailDocType)}
              />
              <SelectField label="Position" name="position" defaultValue={template?.position ?? "HEAD"} options={POSITIONS.map((p) => ({ value: p.value, label: p.label }))} />
            </div>
          )}
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">
            Text<span className="text-stamp"> *</span>
          </span>
          <textarea
            rows={8}
            name="body"
            required
            className="w-full rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen focus:outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Text mit Platzhaltern, z. B. {{document.number}}"
          />
        </label>

        <CheckboxField label="Als Standard fuer Dokumenttyp und Position verwenden" name="isDefault" defaultChecked={template?.isDefault} />

        <div className="flex items-center gap-3">
          <SubmitButton>Vorlage speichern</SubmitButton>
          <button type="button" onClick={loadPreview} disabled={previewBusy} className="rounded-md border border-rule-strong bg-sheet px-3 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60">
            {previewBusy ? "…" : "Vorschau"}
          </button>
        </div>

        {preview && (
          <div className="space-y-2 rounded-md border border-rule bg-paper p-3 text-sm">
            <pre className="whitespace-pre-wrap font-sans text-ink-soft">{preview.body}</pre>
            {preview.warnings.length > 0 && (
              <div className="rounded-md border border-seal/30 bg-seal/10 p-2 text-xs text-seal">{preview.warnings.join(", ")}</div>
            )}
          </div>
        )}
      </form>

      <aside className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
        <h3 className="font-semibold text-ink">Platzhalter (Auswahl)</h3>
        <ul className="space-y-1 text-xs text-ink-muted">
          <li>
            <code className="rounded bg-well px-1.5 py-0.5">{"{{document.number}}"}</code> Belegnummer
          </li>
          <li>
            <code className="rounded bg-well px-1.5 py-0.5">{"{{document.date}}"}</code> Datum
          </li>
          <li>
            <code className="rounded bg-well px-1.5 py-0.5">{"{{customer.name}}"}</code> Kundenname
          </li>
          <li>
            <code className="rounded bg-well px-1.5 py-0.5">{"{{offer.validUntil}}"}</code> Gültig bis (Angebot)
          </li>
          <li>
            <code className="rounded bg-well px-1.5 py-0.5">{"{{company.name}}"}</code> Eigene Firma
          </li>
          {customFieldPlaceholders.map((p) => (
            <li key={p.path}>
              <code className="rounded bg-well px-1.5 py-0.5">{`{{${p.path}}}`}</code> {p.label}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
