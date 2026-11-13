"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelPostalJobAction, resolveUnknownPostalJobAction } from "@/app/actions/postal";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { remainingLabel } from "./format";

/**
 * Aktionen je Postauftrag: Stornieren (nur QUEUED/HOLD/DRAFT binnen 15 Minuten) und
 * "Manuell abschließen" bei unklarem Ausgang (UNKNOWN). Die Restzeit kommt vom Server.
 */
export function PostalJobActions({
  jobId,
  docNumber,
  status,
  cancellable,
  remainingMs,
}: {
  jobId: string;
  docNumber: string;
  status: string;
  cancellable: boolean;
  remainingMs: number | null;
}) {
  const router = useRouter();
  const cancelRef = useRef<ConfirmDialogHandle>(null);
  const resolveRef = useRef<HTMLDialogElement>(null);
  const [pending, start] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"SENT" | "NOT_SENT">("NOT_SENT");
  const [note, setNote] = useState("");

  function cancel() {
    setCancelError(null);
    start(async () => {
      const res = await cancelPostalJobAction(jobId, true);
      if (!res.ok) {
        setCancelError(res.error);
        cancelRef.current?.close();
        return;
      }
      cancelRef.current?.close();
      router.refresh();
    });
  }

  function resolve(e: React.FormEvent) {
    e.preventDefault();
    setResolveError(null);
    start(async () => {
      const res = await resolveUnknownPostalJobAction({ jobId, outcome, note });
      if (!res.ok) {
        setResolveError(res.error);
        return;
      }
      resolveRef.current?.close();
      setNote("");
      router.refresh();
    });
  }

  if (!cancellable && status !== "UNKNOWN") return null;

  return (
    <div className="flex flex-col items-start gap-1">
      {cancellable && (
        <>
          <button type="button" onClick={() => cancelRef.current?.open()} className="rounded-md border border-stamp/30 px-2 py-1 text-xs font-medium text-stamp hover:bg-stamp/10">
            Stornieren{remainingMs !== null ? ` (noch ${remainingLabel(remainingMs)})` : ""}
          </button>
          <ConfirmDialog
            ref={cancelRef}
            tone="danger"
            title={`Postauftrag ${docNumber} stornieren?`}
            confirmLabel="Stornieren"
            busy={pending}
            onConfirm={cancel}
            message="Der Auftrag wird beim Briefdienst gelöscht, bevor er gedruckt wird. Das ist nur kurz nach der Übertragung möglich."
          />
        </>
      )}
      {status === "UNKNOWN" && (
        <>
          <button
            type="button"
            onClick={() => resolveRef.current?.showModal()}
            className="rounded-md border border-rule-strong bg-sheet px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper"
          >
            Manuell abschließen
          </button>
          <dialog ref={resolveRef} className="w-full max-w-md rounded-lg border border-rule p-0 backdrop:bg-ink/40">
            <form onSubmit={resolve} className="space-y-3 p-5 text-sm">
              <h2 className="text-sm font-semibold text-ink">Postauftrag {docNumber} manuell abschließen</h2>
              <p className="text-ink-soft">
                Der Ausgang dieser Übertragung ist unklar. Bitte beim Briefdienst prüfen, ob der Brief dort angekommen ist, und das Ergebnis eintragen. Es wird nie automatisch erneut versendet.
              </p>
              <label className="flex items-start gap-2">
                <input type="radio" name="outcome" checked={outcome === "SENT"} onChange={() => setOutcome("SENT")} className="mt-1 h-4 w-4" />
                <span>Der Brief wurde versendet.</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="outcome" checked={outcome === "NOT_SENT"} onChange={() => setOutcome("NOT_SENT")} className="mt-1 h-4 w-4" />
                <span>Der Brief wurde nicht versendet (ein neuer Versand ist danach möglich).</span>
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-soft">Notiz (Pflicht, mindestens 3 Zeichen)</span>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className="w-full rounded-md border border-rule-strong px-2 py-1.5 text-sm focus:border-pen" />
              </label>
              {resolveError && <p className="text-stamp">{resolveError}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => resolveRef.current?.close()} className="text-sm text-ink-muted hover:text-ink">
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={pending || note.trim().length < 3}
                  className="rounded-md bg-pen px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60"
                >
                  Abschließen
                </button>
              </div>
            </form>
          </dialog>
        </>
      )}
      {cancelError && <span className="text-xs text-stamp">{cancelError}</span>}
    </div>
  );
}
