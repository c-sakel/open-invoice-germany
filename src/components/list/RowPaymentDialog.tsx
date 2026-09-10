"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Generischer Dialog-Rahmen fuer Zeilen-Direktknoepfe (Phase 13a, Task 7) UND fuer die
 * Belegseite (Phase 13c, Task 5, Review-Fund zu Task 3: EIN Dialograhmen im Projekt statt
 * eines zweiten eigenen in `rechnungen/[id]/_parts/PaymentDialog.tsx`) — nativer `<dialog>`
 * statt eigenem Overlay: Zentrierung, Fokusfalle und Esc kommen vom Browser bzw. aus der
 * globalen Regel `dialog:modal { margin: auto }` (Phase 12a, `globals.css`), hier nicht neu
 * gebaut. `onClose` feuert bei JEDEM Schliessen (Esc, ✕-Knopf, `PaymentForm.onDone`) — der
 * Aufrufer entscheidet, was das bedeutet (Zeilen-State zuruecksetzen bzw. auf der Belegseite
 * den Anker `#zahlung` aus der URL nehmen). `RowActionsMenu` bettet das bestehende
 * `PaymentForm` als Kind ein; der Rahmen selbst kennt PaymentForm nicht.
 */
export function RowPaymentDialog({
  open,
  onClose,
  title,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Belegseite (breiteres Formular): 42rem statt der Standardbreite max-w-md — derselbe
   *  Wert, den Tailwinds `max-w-2xl`-Utility erzeugt. Ueber `style.maxWidth` statt einer
   *  zweiten Klasse, damit `className` eine unveraenderte statische Zeichenkette bleibt
   *  (`test/unit/dialogs.test.ts` liest `<dialog>`-Tags textuell auf `w-full`/`max-w-*` in
   *  `className="..."` — eine bedingte `className`-Ausdruck wuerde dort durchfallen). */
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40"
      style={wide ? { maxWidth: "42rem" } : undefined}
    >
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Schließen" className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
