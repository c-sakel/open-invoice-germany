"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { setIncomingStatusAction } from "@/app/eingang/actions";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/forms/fields";
import {
  ACTION_LABELS,
  PAID_HINT,
  actionNeedsReason,
  formatIsoDay,
  formatReceivedAt,
  reasonProblem,
  statusLabel,
  type IncomingActionName,
} from "./incoming-ui";

export interface WorkflowView {
  status: string;
  dueAt: string | null;
  checkedAt: string | null;
  checkedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  paidMarkedAt: string | null;
}

interface Props {
  id: string;
  workflow: WorkflowView;
  allowedActions: IncomingActionName[];
  /** Heutiger Berliner Kalendertag, Vorbelegung des Zahltags. */
  today: string;
}

const DIALOG_ACTIONS: readonly IncomingActionName[] = ["REJECT", "REVERT", "MARK_PAID"];

/** Aktionsknöpfe aus den erlaubten Aktionen; Ablehnen und Zurücksetzen verlangen einen Grund, "bezahlt" ein Datum und einen Vermerk. */
export function IncomingWorkflow({ id, workflow, allowedActions, today }: Props) {
  const router = useRouter();
  const rejectRef = useRef<HTMLDialogElement>(null);
  const revertRef = useRef<HTMLDialogElement>(null);
  const paidRef = useRef<HTMLDialogElement>(null);
  const dialogOf = (a: IncomingActionName): HTMLDialogElement | null =>
    a === "REJECT" ? rejectRef.current : a === "REVERT" ? revertRef.current : a === "MARK_PAID" ? paidRef.current : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [paidNote, setPaidNote] = useState("");

  async function run(action: IncomingActionName, extra: { reason?: string; paidOn?: string; paidNote?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const r = await setIncomingStatusAction(id, { action, ...extra });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      for (const a of DIALOG_ACTIONS) dialogOf(a)?.close();
      setReason("");
      setPaidNote("");
      router.refresh();
    } catch {
      setError("Die Aktion konnte nicht ausgeführt werden.");
    } finally {
      setBusy(false);
    }
  }

  function open(action: IncomingActionName) {
    setError(null);
    if (DIALOG_ACTIONS.includes(action)) dialogOf(action)?.showModal();
    else void run(action);
  }

  function submitDialog(action: IncomingActionName) {
    if (actionNeedsReason(action)) {
      const p = reasonProblem(reason);
      if (p) {
        setError(p);
        return;
      }
      void run(action, { reason: reason.trim() });
    } else {
      void run(action, {
        paidOn,
        ...(paidNote.trim() !== "" ? { paidNote: paidNote.trim() } : {}),
      });
    }
  }

  const times: [string, string | null, string | null][] = [
    ["Geprüft", workflow.checkedAt, workflow.checkedBy],
    ["Freigegeben", workflow.approvedAt, workflow.approvedBy],
    ["Abgelehnt", workflow.rejectedAt, workflow.rejectedBy],
  ];

  return (
    <section aria-label="Bearbeitung" className="space-y-3 rounded-md border border-rule bg-paper p-4 text-sm">
      <h2 className="text-base font-medium text-ink">Bearbeitung</h2>
      <p className="text-ink">
        Status: <span className="font-medium">{statusLabel(workflow.status)}</span>
        {workflow.dueAt ? <span className="text-ink-soft"> · fällig {formatIsoDay(workflow.dueAt)}</span> : null}
      </p>
      <ul className="space-y-0.5 text-ink-soft">
        {times.map(([label, at, by]) =>
          at ? (
            <li key={label}>
              {label}: {formatReceivedAt(at)}
              {by ? ` (${by})` : ""}
            </li>
          ) : null,
        )}
        {workflow.paidMarkedAt ? <li>Als bezahlt vermerkt: {formatIsoDay(workflow.paidMarkedAt)}</li> : null}
      </ul>
      {workflow.rejectReason ? <p className="break-words text-ink-soft">Grund: {workflow.rejectReason}</p> : null}
      {workflow.status === "PAID" ? <p className="text-xs text-ink-muted">{PAID_HINT}</p> : null}

      {allowedActions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {allowedActions.map((a) => (
            <Button key={a} variant={a === "REJECT" ? "danger-quiet" : a === "REVERT" ? "secondary" : "primary"} disabled={busy} onClick={() => open(a)}>
              {ACTION_LABELS[a]}
            </Button>
          ))}
        </div>
      ) : null}
      <p role="alert" aria-live="assertive" className={error ? "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900" : "sr-only"}>
        {error}
      </p>

      {(["REJECT", "REVERT"] as const)
        .filter((a) => allowedActions.includes(a))
        .map((a) => (
          <dialog
            key={a}
            ref={a === "REJECT" ? rejectRef : revertRef}
            aria-label={ACTION_LABELS[a]}
            className="w-full max-w-md rounded-md border border-rule bg-sheet p-4 text-sm backdrop:bg-black/30"
          >
            <form
              method="dialog"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                submitDialog(a);
              }}
            >
              <h3 className="text-base font-medium text-ink">{ACTION_LABELS[a]}</h3>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-ink-soft">Grund (Pflicht, 3 bis 500 Zeichen)</span>
                <textarea className={inputCls} rows={3} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="quiet" onClick={() => dialogOf(a)?.close()}>
                  Abbrechen
                </Button>
                <Button variant="primary" type="submit" disabled={busy}>
                  {ACTION_LABELS[a]}
                </Button>
              </div>
            </form>
          </dialog>
        ))}

      {allowedActions.includes("MARK_PAID") ? (
        <dialog
          ref={paidRef}
          aria-label={ACTION_LABELS.MARK_PAID}
          className="w-full max-w-md rounded-md border border-rule bg-sheet p-4 text-sm backdrop:bg-black/30"
        >
          <form
            method="dialog"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitDialog("MARK_PAID");
            }}
          >
            <h3 className="text-base font-medium text-ink">{ACTION_LABELS.MARK_PAID}</h3>
            <p className="text-xs text-ink-muted">{PAID_HINT}</p>
            <label className="flex flex-col gap-1">
              <span className="font-medium text-ink-soft">Zahltag</span>
              <input type="date" className={inputCls} required max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium text-ink-soft">Vermerk (optional)</span>
              <textarea className={inputCls} rows={2} maxLength={500} value={paidNote} onChange={(e) => setPaidNote(e.target.value)} />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => dialogOf("MARK_PAID")?.close()}>
                Abbrechen
              </Button>
              <Button variant="primary" type="submit" disabled={busy}>
                Vermerken
              </Button>
            </div>
          </form>
        </dialog>
      ) : null}
    </section>
  );
}
