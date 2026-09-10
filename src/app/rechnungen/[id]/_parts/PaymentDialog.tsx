"use client";

import { useEffect, useId, useRef } from "react";
import { PaymentForm } from "@/components/PaymentForm";
import { formatCents } from "@/lib/money";

/**
 * Phase 13c, Task 3: die Zahlungserfassung sitzt nicht mehr als Dauerformular in der
 * rechten Spalte, sondern in einem modalen Dialog — dasselbe `PaymentForm`, dieselbe
 * Route (POST /api/invoices/[id]/payment), derselbe Domain-Pfad (recordPayment). Dialog-
 * Muster wie `PauseDialog`/`ConfirmDialog` (nativer `<dialog>`, `useRef<HTMLDialogElement>`,
 * `showModal()`/`close()`) — Fokusfalle und Esc kommen vom Browser, die Zentrierung aus
 * der globalen `dialog:modal`-Regel (Phase 12a, `globals.css`); `aria-labelledby` wie
 * `ConfirmDialog`.
 *
 * Der Anker `#zahlung` bleibt gueltig: jeder Bestandslink aus Liste, Mahnwesen und
 * Kopfzeile oeffnet diesen Dialog (beim Laden mit gesetztem Hash und bei jedem
 * `hashchange`) — es gibt genau EINE Instanz auf der Belegseite (in `InvoiceStatusCard`,
 * `canPay`-gated); die Kopfzeile (Task 4) verlinkt nur per `href="#zahlung"` dorthin statt
 * eine zweite Instanz zu rendern (Koordinator-Nachtrag: kein zweiter Dialog).
 *
 * Ruling: "Als bezahlt markieren" bucht NIE still — vorbelegt (Offenbetrag, heutiges
 * Datum, Standardmethode; macht `PaymentForm` bereits selbst), gebucht wird erst auf
 * Klick auf "Buchen" im Formular.
 */
export function PaymentDialog({
  invoiceId,
  openCents,
  methods,
  defaultMethod,
  label = "Zahlung erfassen",
  asMenuItem = false,
}: {
  invoiceId: string;
  openCents: number;
  methods: { code: string; name: string }[];
  defaultMethod: string;
  /** Beschriftung des oeffnenden Knopfes (Kopfzeile: "Als bezahlt markieren"). */
  label?: string;
  /** true: als Menuezeile statt als Knopf rendern. */
  asMenuItem?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    function openIfAnchored() {
      if (window.location.hash === "#zahlung" && !ref.current?.open) ref.current?.showModal();
    }
    openIfAnchored();
    window.addEventListener("hashchange", openIfAnchored);
    return () => window.removeEventListener("hashchange", openIfAnchored);
  }, []);

  function close() {
    ref.current?.close();
    // Hash zuruecksetzen, sonst oeffnet ein erneuter Klick auf denselben Anker nicht mehr
    // (der Hash aendert sich dann nicht und `hashchange` feuert nicht).
    if (window.location.hash === "#zahlung") history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const triggerCls = asMenuItem
    ? "block w-full rounded-md px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
    : "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700";

  return (
    <>
      {/* Anker-Ziel: Bestandslinks (#zahlung) springen hierher UND oeffnen den Dialog. */}
      <span id="zahlung" />
      <button type="button" onClick={() => ref.current?.showModal()} className={triggerCls}>
        {label}
      </button>
      <dialog ref={ref} aria-labelledby={titleId} className="w-full max-w-2xl rounded-lg border border-slate-200 p-5 backdrop:bg-slate-900/40">
        <h2 id={titleId} className="mb-1 text-base font-semibold text-slate-900">
          Zahlung erfassen
        </h2>
        <p className="mb-3 text-sm text-slate-500">Offen: {formatCents(openCents)}</p>
        <PaymentForm invoiceId={invoiceId} openCents={openCents} methods={methods} defaultMethod={defaultMethod} onDone={close} />
        <div className="mt-3 text-right">
          <button type="button" onClick={close} className="text-sm text-slate-500 hover:text-slate-800">
            Schließen
          </button>
        </div>
      </dialog>
    </>
  );
}
