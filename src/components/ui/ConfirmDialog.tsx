"use client";

/**
 * Gemeinsame Bestaetigung fuer <dialog>-Dialoge OHNE eigenes Formular (Phase 12a).
 * Zwei per Typ-Union getrennte Varianten: `onConfirm` (Rueckruf) oder `confirmHref`
 * (next/link-Ziel, Editor "Trotzdem verlassen?"). Die Zentrierung kommt aus der
 * globalen Regel `dialog:modal { margin: auto }` — hier nicht nachgebaut.
 * Escape schliesst nativ; der Fokus landet beim Oeffnen auf "Abbrechen".
 */
import Link from "next/link";
import { forwardRef, useImperativeHandle, useRef } from "react";

export interface ConfirmDialogHandle {
  open: () => void;
  close: () => void;
}

type ConfirmDialogProps = {
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
} & ({ onConfirm: () => void; confirmHref?: never } | { confirmHref: string; onConfirm?: never });

const TONE_CLS: Record<"default" | "danger", string> = {
  default: "bg-indigo-600 hover:bg-indigo-700",
  danger: "bg-rose-600 hover:bg-rose-700",
};

export const ConfirmDialog = forwardRef<ConfirmDialogHandle, ConfirmDialogProps>(function ConfirmDialog(
  { title, message, confirmLabel, cancelLabel = "Abbrechen", tone = "default", onConfirm, confirmHref },
  ref,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    open: () => {
      dialogRef.current?.showModal();
      cancelRef.current?.focus();
    },
    close: () => dialogRef.current?.close(),
  }));

  const confirmCls = `rounded-md px-3 py-1.5 text-sm font-medium text-white ${TONE_CLS[tone]}`;

  return (
    <dialog ref={dialogRef} className="w-full max-w-sm rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40">
      <div className="space-y-3 p-5">
        {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
        <p className="text-sm text-slate-700">{message}</p>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => dialogRef.current?.close()} className="text-sm text-slate-500 hover:text-slate-800">
            {cancelLabel}
          </button>
          {confirmHref ? (
            <Link href={confirmHref} className={confirmCls} onClick={() => dialogRef.current?.close()}>
              {confirmLabel}
            </Link>
          ) : (
            <button type="button" className={confirmCls} onClick={() => { dialogRef.current?.close(); onConfirm?.(); }}>
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
});
