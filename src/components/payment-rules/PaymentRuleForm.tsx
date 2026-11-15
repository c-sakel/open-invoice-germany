"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createPaymentRuleAction, updatePaymentRuleAction } from "@/app/einstellungen/zahlungsregeln/actions";
import { PAYMENT_SOURCES } from "@/schemas/payment-rule";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import {
  ACTION_LABELS, PAYMENT_CONFIRMATION_TEMPLATE_TYPE, SOURCE_LABELS, TRIGGER_LABELS, emptyRuleFormState, validateRuleForm,
  type RuleFormState,
} from "./rule-form-model";

export interface PaymentRuleFormProps {
  /** Vorbelegung (Bearbeiten) mit der Regel-Id; ohne = neue Regel. */
  ruleId?: string;
  initial?: RuleFormState;
  tags: { id: string; name: string }[];
  templates: { id: string; name: string; docType: string }[];
  onDone?: () => void;
}

export function PaymentRuleForm({ ruleId, initial, tags, templates, onDone }: PaymentRuleFormProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [s, setS] = useState<RuleFormState>(initial ?? emptyRuleFormState());
  const [error, setError] = useState<string | null>(null);
  const confirmTemplates = templates.filter((t) => t.docType === PAYMENT_CONFIRMATION_TEMPLATE_TYPE);

  const patch = (p: Partial<RuleFormState>) => setS((cur) => ({ ...cur, ...p }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const v = validateRuleForm(s);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    start(async () => {
      const res = ruleId ? await updatePaymentRuleAction(ruleId, v.input) : await createPaymentRuleAction(v.input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      onDone?.();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 sm:p-5">
      <h2 className="font-semibold text-ink">{ruleId ? "Regel bearbeiten" : "Neue Regel"}</h2>
      <ErrorBanner message={error ?? undefined} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Name</span>
        <input className={inputCls} value={s.name} maxLength={100} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium text-ink-soft">Auslöser</legend>
        {(Object.keys(TRIGGER_LABELS) as (keyof typeof TRIGGER_LABELS)[]).map((t) => (
          <label key={t} className="flex items-center gap-2">
            <input type="radio" name="trigger" checked={s.trigger === t} onChange={() => patch({ trigger: t })} />
            <span>{TRIGGER_LABELS[t]}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1 text-sm">
        <legend className="font-medium text-ink-soft">Quellen der Zahlung</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.allSources} onChange={(e) => patch({ allSources: e.target.checked })} />
          <span>Alle Quellen</span>
        </label>
        {!s.allSources && (
          <div className="grid gap-1 sm:grid-cols-2">
            {PAYMENT_SOURCES.map((src) => (
              <label key={src} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.sources.includes(src)}
                  onChange={(e) => patch({ sources: e.target.checked ? [...s.sources, src] : s.sources.filter((x) => x !== src) })}
                />
                <span>{SOURCE_LABELS[src]}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <label className="flex max-w-sm flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Nur Rechnungen mit Tag</span>
        <select className={inputCls} value={s.invoiceTagId} onChange={(e) => patch({ invoiceTagId: e.target.value })}>
          <option value="">Kein Filter</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>

      <label className="flex max-w-xs flex-col gap-1 text-sm">
        <span className="font-medium text-ink-soft">Wartezeit (Minuten)</span>
        <input className={inputCls} inputMode="numeric" value={s.delayMinutes} onChange={(e) => patch({ delayMinutes: e.target.value })} />
        <span className="text-xs text-ink-muted">
          Eine Gegenbuchung innerhalb der Wartezeit verhindert die Aktionen. Die Ausführung erfolgt spätestens mit dem nächsten Scheduler-Lauf.
        </span>
      </label>

      <fieldset className="space-y-3 text-sm">
        <legend className="font-medium text-ink-soft">Aktionen</legend>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.confirm.on} onChange={(e) => patch({ confirm: { ...s.confirm, on: e.target.checked } })} />
            <span>{ACTION_LABELS.SEND_PAYMENT_CONFIRMATION}</span>
          </label>
          {s.confirm.on && (
            <div className="ml-6 space-y-1">
              <select className={`${inputCls} max-w-sm`} aria-label="Mailvorlage" value={s.confirm.templateId} onChange={(e) => patch({ confirm: { ...s.confirm, templateId: e.target.value } })}>
                <option value="">Standardvorlage</option>
                {confirmTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <p className="text-xs text-ink-muted">
                Vorlagen vom Typ Zahlungsbestätigung pflegen Sie unter <Link className="underline" href="/einstellungen/vorlagen">Textvorlagen</Link>.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.tag.on} onChange={(e) => patch({ tag: { ...s.tag, on: e.target.checked } })} />
            <span>{ACTION_LABELS.ADD_TAG}</span>
          </label>
          {s.tag.on && (
            <select className={`${inputCls} ml-6 max-w-sm`} aria-label="Tag" value={s.tag.tagId} onChange={(e) => patch({ tag: { ...s.tag, tagId: e.target.value } })}>
              <option value="">Tag wählen</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.notify.on} onChange={(e) => patch({ notify: { ...s.notify, on: e.target.checked } })} />
            <span>{ACTION_LABELS.NOTIFY}</span>
          </label>
          {s.notify.on && (
            <input className={`${inputCls} ml-6 w-[calc(100%-1.5rem)] max-w-md`} aria-label="Notiz" placeholder="Notiz (optional)" maxLength={300} value={s.notify.note} onChange={(e) => patch({ notify: { ...s.notify, note: e.target.value } })} />
          )}
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.webhook.on} onChange={(e) => patch({ webhook: { on: e.target.checked } })} />
          <span>{ACTION_LABELS.EMIT_WEBHOOK}</span>
        </label>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.resume.on} onChange={(e) => patch({ resume: { ...s.resume, on: e.target.checked } })} />
            <span>{ACTION_LABELS.RESUME_RECURRING}</span>
          </label>
          {s.resume.on && (
            <div className="ml-6 space-y-1">
              <select className={`${inputCls} max-w-sm`} aria-label="Verpasste Perioden" value={s.resume.missedPeriods} onChange={(e) => patch({ resume: { ...s.resume, missedPeriods: e.target.value === "BILL" ? "BILL" : "SKIP" } })}>
                <option value="SKIP">Verpasste Perioden überspringen</option>
                <option value="BILL">Verpasste Perioden nachberechnen</option>
              </select>
              <p className="text-xs text-ink-muted">
                Überspringen: Das Abo läuft ab der nächsten Periode weiter. Nachberechnen: Für jede pausierte Periode wird eine Rechnung erzeugt.
              </p>
            </div>
          )}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.active} onChange={(e) => patch({ active: e.target.checked })} />
        <span className="text-ink-soft">Regel ist aktiv</span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Speichern …" : "Speichern"}</Button>
        {onDone && <Button variant="secondary" onClick={onDone} disabled={pending}>Abbrechen</Button>}
      </div>
    </form>
  );
}
