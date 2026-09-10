"use client";

import { useEffect, useState } from "react";
import { RowPaymentDialog } from "@/components/list/RowPaymentDialog";
import { PaymentForm } from "@/components/PaymentForm";
import { formatCents } from "@/lib/money";

/**
 * Phase 13c, Task 3 (Review-Fund zu Task 3, Task 5): die Zahlungserfassung sitzt nicht mehr
 * als Dauerformular in der rechten Spalte, sondern in `RowPaymentDialog` — demselben
 * Dialograhmen wie die Zeilen-Direktknoepfe (`RowActionsMenu`), kein zweiter eigener Rahmen
 * mehr im Projekt. Dasselbe `PaymentForm`, dieselbe Route (POST /api/invoices/[id]/payment),
 * derselbe Domain-Pfad (recordPayment).
 *
 * Der Anker `#zahlung` bleibt gueltig: jeder Bestandslink aus Liste, Mahnwesen und
 * Kopfzeile oeffnet diesen Dialog (beim Laden mit gesetztem Hash und bei jedem
 * `hashchange`) — es gibt genau EINE Instanz auf der Belegseite (in `InvoiceStatusCard`,
 * `canPay`-gated); die Kopfzeile (Task 4) verlinkt nur per `href="#zahlung"` dorthin statt
 * eine zweite Instanz zu rendern (Koordinator-Nachtrag: kein zweiter Dialog).
 *
 * `close()` ist der EINE Schliesspfad: Esc, der ✕-Knopf (`RowPaymentDialog`s `onClose`) und
 * erfolgreiches Buchen (`PaymentForm.onDone`) rufen alle dieselbe Funktion — sie nimmt den
 * Hash aus der URL, sonst oeffnet ein erneuter Klick auf denselben Anker den Dialog nicht
 * wieder (der Hash aendert sich sonst nicht, `hashchange` feuert nicht).
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
}: {
  invoiceId: string;
  openCents: number;
  methods: { code: string; name: string }[];
  defaultMethod: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function openIfAnchored() {
      if (window.location.hash === "#zahlung") setOpen(true);
    }
    openIfAnchored();
    window.addEventListener("hashchange", openIfAnchored);
    return () => window.removeEventListener("hashchange", openIfAnchored);
  }, []);

  function close() {
    setOpen(false);
    // Hash zuruecksetzen, sonst oeffnet ein erneuter Klick auf denselben Anker nicht mehr
    // (der Hash aendert sich dann nicht und `hashchange` feuert nicht).
    if (window.location.hash === "#zahlung") history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  return (
    <>
      {/* Anker-Ziel: Bestandslinks (#zahlung) springen hierher UND oeffnen den Dialog. */}
      <span id="zahlung" />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
      >
        Zahlung erfassen
      </button>
      <RowPaymentDialog open={open} onClose={close} title="Zahlung erfassen" wide>
        <p className="mb-3 text-sm text-slate-500">Offen: {formatCents(openCents)}</p>
        <PaymentForm invoiceId={invoiceId} openCents={openCents} methods={methods} defaultMethod={defaultMethod} onDone={close} />
      </RowPaymentDialog>
    </>
  );
}
