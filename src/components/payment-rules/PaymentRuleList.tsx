"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archivePaymentRuleAction, previewPaymentRuleAction, updatePaymentRuleAction } from "@/app/einstellungen/zahlungsregeln/actions";
import type { PaymentRulePreview } from "@/domain/payment-rule/preview";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import { PaymentRuleForm } from "./PaymentRuleForm";
import { ACTION_LABELS, SOURCE_LABELS, TRIGGER_LABELS, ruleToFormState } from "./rule-form-model";
import type { PaymentRuleInput } from "@/schemas/payment-rule";

export interface RuleRowView extends PaymentRuleInput {
  id: string;
  tagMissing: boolean;
  broken?: boolean;
}

interface Props {
  rules: RuleRowView[];
  tags: { id: string; name: string }[];
  templates: { id: string; name: string; docType: string }[];
}

const WARN_PREFIXES = ["wuerde fehlschlagen", "wuerde nicht erneut", "wuerde verschoben", "wuerde uebersprungen"];

/** Hinweise des Trockenlaufs, die den tatsaechlichen Versand/die Ausfuehrung verhindern oder verzoegern, werden hervorgehoben. */
export function isPreviewWarning(outcome: string): boolean {
  return WARN_PREFIXES.some((p) => outcome.startsWith(p));
}

export function PreviewResult({ result }: { result: PaymentRulePreview }) {
  return (
    <div className="space-y-2 rounded-md border border-rule bg-paper p-3 text-sm">
      <p className="font-medium text-ink">{result.matches ? "Die Regel würde auslösen." : "Die Regel würde nicht auslösen."}</p>
      {result.reasons.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-ink-soft">{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      <ul className="space-y-2">
        {result.steps.map((st, i) => (
          <li key={`${st.type}-${i}`} className="space-y-1">
            <p className={isPreviewWarning(st.outcome) ? "font-medium text-stamp" : "text-ink-soft"}>
              <span className="text-ink">{ACTION_LABELS[st.type as keyof typeof ACTION_LABELS] ?? st.type}:</span> {st.outcome}
            </p>
            {st.mail && st.mail.subject !== "" && (
              <div className="rounded border border-rule bg-sheet p-2 text-xs">
                <p><span className="text-ink-muted">An:</span> {st.mail.to ?? "—"}</p>
                <p><span className="text-ink-muted">Betreff:</span> {st.mail.subject}</p>
                <p className="mt-1 whitespace-pre-line">{st.mail.body}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-muted">Trockenlauf: Es wird nichts gesendet, gesetzt oder protokolliert.</p>
    </div>
  );
}

function PreviewPanel({ ruleId }: { ruleId: string }) {
  const [number, setNumber] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentRulePreview | null>(null);

  function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    start(async () => {
      const res = await previewPaymentRuleAction({ ruleId, invoiceNumber: number });
      if (!res.ok) setError(res.error);
      else setResult(res.data);
    });
  }

  return (
    <div className="space-y-2">
      <form onSubmit={run} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Rechnungsnummer</span>
          <input className={inputCls} value={number} maxLength={64} onChange={(e) => setNumber(e.target.value)} />
        </label>
        <Button type="submit" variant="secondary" disabled={pending}>{pending ? "Prüfe …" : "Trockenlauf"}</Button>
      </form>
      <ErrorBanner message={error ?? undefined} />
      {result && <PreviewResult result={result} />}
    </div>
  );
}

export function PaymentRuleList({ rules, tags, templates }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function mutate(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "Aktion fehlgeschlagen.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={error ?? undefined} />
      {rules.length === 0 && <p className="text-sm text-ink-muted">Noch keine Regel angelegt. Ohne Regel passiert nach einer Zahlung nichts zusätzlich.</p>}
      <ul className="space-y-3">
        {rules.map((r) => (
          <li key={r.id} className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
            {editing === r.id ? (
              <PaymentRuleForm ruleId={r.id} initial={ruleToFormState(r)} tags={tags} templates={templates} onDone={() => setEditing(null)} />
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <p className="font-semibold text-ink">{r.name}</p>
                    <p className="text-xs text-ink-soft">
                      {TRIGGER_LABELS[r.trigger]} · Quellen: {r.sources === null ? "alle" : r.sources.map((s) => SOURCE_LABELS[s]).join(", ")} · Wartezeit {r.delayMinutes} Min.
                    </p>
                    <p className="text-xs text-ink-soft">Aktionen: {r.actions.map((a) => ACTION_LABELS[a.type]).join(", ")}</p>
                    {r.broken && <p className="text-xs font-medium text-stamp">Defekt: Die gespeicherte Regel ist nicht lesbar und wird nicht ausgeführt. Bitte neu anlegen.</p>}
                    {r.tagMissing && <p className="text-xs font-medium text-stamp">Ein verwendeter Tag existiert nicht mehr. Bitte die Regel anpassen.</p>}
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.active}
                      disabled={pending}
                      onChange={(e) => mutate(() => updatePaymentRuleAction(r.id, { active: e.target.checked }))}
                    />
                    <span className="text-ink-soft">aktiv</span>
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(r.id)}>Bearbeiten</Button>
                  <Button variant="secondary" size="sm" onClick={() => setTesting(testing === r.id ? null : r.id)}>Trockenlauf</Button>
                  <Button
                    variant="danger-quiet" size="sm" disabled={pending}
                    onClick={() => { if (window.confirm(`Regel „${r.name}“ archivieren? Geplante, noch nicht ausgeführte Läufe werden übersprungen.`)) mutate(() => archivePaymentRuleAction(r.id)); }}
                  >
                    Archivieren
                  </Button>
                </div>
                {testing === r.id && <PreviewPanel ruleId={r.id} />}
              </>
            )}
          </li>
        ))}
      </ul>
      {editing === "new" ? (
        <PaymentRuleForm tags={tags} templates={templates} onDone={() => setEditing(null)} />
      ) : (
        <Button variant="primary" onClick={() => setEditing("new")}>Neue Regel</Button>
      )}
    </div>
  );
}
