"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { retryPaymentRuleRunAction } from "@/app/einstellungen/zahlungsregeln/actions";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/forms/fields";
import { ACTION_LABELS, RUN_STATUS_LABELS, STEP_STATUS_LABELS, isMailFollowUp } from "./rule-form-model";

export interface RunRow {
  id: string;
  createdAt: string;
  invoiceId: string;
  invoiceNumber: string | null;
  ruleName: string;
  status: string;
  steps: unknown;
  /** Bereits nach aussen bereinigt (public-error), nie ein Rohtext. */
  lastError: string | null;
  skipReason: string | null;
}

const STATUS_CLS: Record<string, string> = {
  DONE: "bg-ledger/10 text-ledger", FAILED: "bg-stamp/10 text-stamp", PENDING: "bg-pen-wash text-pen", RUNNING: "bg-pen-wash text-pen", SKIPPED: "bg-well text-ink-soft",
};

function deDateTime(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" }).format(new Date(iso));
}

function stepList(steps: unknown): { type: string; status: string }[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s: unknown) => {
    if (typeof s !== "object" || s === null || !("type" in s) || !("status" in s)) return [];
    return typeof s.type === "string" && typeof s.status === "string" ? [{ type: s.type, status: s.status }] : [];
  });
}

function RetryControl({ run }: { run: RunRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const followUp = isMailFollowUp(run.steps);

  function go() {
    setError(null);
    start(async () => {
      const res = await retryPaymentRuleRunAction({ runId: run.id, confirmFollowUp: followUp });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAsking(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <ErrorBanner message={error ?? undefined} />
      {asking ? (
        <div role="alertdialog" className="space-y-2 rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-ink">
          <p>
            Folgeversand: Die erste Zahlungsbestätigung kann dem Empfänger bereits zugestellt worden sein. Beim erneuten Versuch wird
            die Mail ein weiteres Mal gesendet. Bitte vorher das E-Mail-Protokoll prüfen.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={go} disabled={pending}>{pending ? "Läuft …" : "Folgeversand bestätigen"}</Button>
            <Button variant="secondary" size="sm" onClick={() => setAsking(false)} disabled={pending}>Abbrechen</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={followUp ? () => setAsking(true) : go} disabled={pending}>
          {followUp ? "Folgeversand erneut versuchen" : "Erneut versuchen"}
        </Button>
      )}
    </div>
  );
}

export function PaymentRuleRunsTable({ runs }: { runs: RunRow[] }) {
  if (runs.length === 0) return <p className="text-sm text-ink-muted">Noch keine Läufe protokolliert.</p>;
  return (
    <ul className="space-y-2">
      {runs.map((r) => (
        <li key={r.id} className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ink-soft">
              {deDateTime(r.createdAt)} · <Link className="underline" href={`/rechnungen/${r.invoiceId}`}>{r.invoiceNumber ?? "Rechnung"}</Link> · {r.ruleName}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLS[r.status] ?? "bg-well text-ink-soft"}`}>{RUN_STATUS_LABELS[r.status] ?? r.status}</span>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            {stepList(r.steps).map((s, i) => (
              <li key={`${s.type}-${i}`}>
                {ACTION_LABELS[s.type as keyof typeof ACTION_LABELS] ?? s.type}: {STEP_STATUS_LABELS[s.status] ?? s.status}
              </li>
            ))}
          </ul>
          {r.skipReason && <p className="text-xs text-ink-muted">Übersprungen: {r.skipReason}</p>}
          {r.lastError && <p className="text-xs text-stamp">{r.lastError}</p>}
          {r.status === "FAILED" && <RetryControl run={r} />}
        </li>
      ))}
    </ul>
  );
}
