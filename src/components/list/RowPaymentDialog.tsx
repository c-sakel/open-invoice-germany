"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Generischer Dialog-Rahmen fuer Zeilen-Direktknoepfe (Phase 13a, Task 7) — nativer
 * `<dialog>` statt eigenem Overlay: Zentrierung, Fokusfalle und Esc kommen vom Browser
 * bzw. aus der globalen Regel `dialog:modal { margin: auto }` (Phase 12a, `globals.css`),
 * hier nicht neu gebaut. `RowActionsMenu` bettet das bestehende `PaymentForm` als Kind ein
 * (dieselbe Server-Action, nur anderer Rahmen als die Menue-eingebettete Variante); der
 * Rahmen selbst kennt PaymentForm nicht, damit ihn 13c fuer die Belegseite wiederverwenden
 * kann.
 */
export function RowPaymentDialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog ref={ref} onClose={onClose} className="w-full max-w-md rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40">
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
