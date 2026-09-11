"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActionKey, ConvertTargets, DocKind } from "@/domain/document/actions";
import { SendEmailDialog } from "@/components/SendEmailDialog";
import { PaymentForm } from "@/components/PaymentForm";
import { ConvertMenu } from "@/components/ConvertMenu";
import { DocumentActionsMenuItems } from "@/components/DocumentActionsMenu";
import { RowPaymentDialog } from "@/components/list/RowPaymentDialog";
import { SaveTemplateDialog } from "@/components/templates/SaveTemplateDialog";
import { shouldForceDunningRetry } from "@/lib/dunning-force";
import type { EmailDocType } from "@/schemas/email";
import type { TagDocType } from "@/schemas/tag";

const itemCls = "block w-full rounded-md px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50";
const linkCls = `${itemCls} no-underline`;
// Task 7: Direktknoepfe vor dem "..."-Menue (PDF/Zahlung) — kompakter als itemCls, fuer den
// engen Platz in einer Tabellenzeile.
const directBtnCls = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50";

interface PaymentMethodOption {
  code: string;
  name: string;
}

/**
 * Zeilen-Schnellaktionen (Phase 8b, §41) — Drei-Punkte-Menue je Zeile in den Listen
 * (Rechnungen/Dokumente/Lieferscheine/Abos), Eintraege aus `availableActions` (Task 1).
 * Task-2-Facts-Ruling: nur bestehende Dialoge/Routen wiederverwenden, KEINE neuen
 * Backends. Reines HTML-`<details>`-Disclosure statt eigenem Open/Close-State — jede
 * Aktion, die einen Dialog braucht (SendEmailDialog/PaymentForm/ConvertMenu), rendert
 * ihren eigenen Trigger-Button innerhalb des Menues.
 */
export function RowActionsMenu({
  kind,
  id,
  actions,
  openHref,
  editHref,
  pdfHref,
  xrechnungHref,
  emailDocType,
  hasEmailLog,
  duplicateRoute,
  duplicateRedirect,
  cancelRoute,
  cancelBody,
  dunningRoute,
  dunningCount,
  payment,
  convert,
  documentActions,
  templateName,
}: {
  kind: DocKind;
  id: string;
  actions: ActionKey[];
  openHref: string;
  /** Nur gesetzt, wenn fuer diesen Beleg tatsaechlich eine Bearbeiten-Seite existiert
   *  (Lieferscheine haben aktuell keine — EDIT wird dann trotz ActionKey nicht gerendert). */
  editHref?: string;
  pdfHref?: string;
  xrechnungHref?: string;
  emailDocType?: EmailDocType;
  hasEmailLog?: boolean;
  duplicateRoute?: string;
  /** Zielpfad nach erfolgreichem Duplizieren, "{id}" wird durch die neue ID ersetzt. */
  duplicateRedirect?: string;
  cancelRoute?: string;
  cancelBody?: Record<string, unknown>;
  dunningRoute?: string;
  /** Fix-Welle (Nit): Anzahl bereits erstellter Mahnungen fuer diesen Beleg — steuert,
   *  ob "Zahlungserinnerung senden" oder "Nächste Mahnung erstellen" angezeigt wird.
   *  `undefined` (Aufrufer liefert den Wert nicht) verhaelt sich wie 0 (bisheriges
   *  Verhalten: REMINDER-Button anzeigen). */
  dunningCount?: number;
  payment?: { openCents: number; methods: PaymentMethodOption[]; defaultMethod: string };
  /** Task 7: Ziele fuer "Umwandeln" (AB/Rechnung/Lieferschein) aus `convertTargets` —
   *  ungesetzt (Task 8 verdrahtet `/dokumente`) zeigt keine CONVERT-Zeile, auch wenn
   *  `actions` den Key enthaelt (wie PAYMENT ohne `payment`). */
  convert?: ConvertTargets;
  /** Task 7: Statuswechsel/Archivieren/Duplizieren ueber die bestehende `DocumentActionsMenuItems` —
   *  keine eigene Uebergangstabelle hier. */
  documentActions?: { type: "QUOTE" | "DELIVERY_NOTE"; status: string; archived: boolean };
  /** Phase 13d, Task 4: Namensvorschlag fuer SaveTemplateDialog ("Als Vorlage speichern",
   *  nur bei `has("TEMPLATE_SAVE")` sichtbar) — i. d. R. die Belegnummer. `kind` liefert
   *  bereits den TagDocType (RECURRING erhaelt TEMPLATE_SAVE nie, siehe availableActions). */
  templateName?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  // Ruling (a), Phase 8b Fix-Runde 1: REMINDER legt zunaechst eine Mahnung an (wie
  // DUNNING), oeffnet danach aber den Versand-Dialog DAFUER (docType DUNNING) statt nur
  // zu aktualisieren — nie den Rechnungs-Versand-Dialog. `key={reminderDunningId}`
  // erzwingt einen Remount von SendEmailDialog, damit dessen `autoOpen`-Effekt greift.
  const [reminderDunningId, setReminderDunningId] = useState<string | null>(null);

  function closeMenu() {
    setDetailsOpen(false);
  }

  async function duplicate() {
    if (!duplicateRoute) return;
    setBusy("DUPLICATE");
    setError(null);
    const res = await fetch(duplicateRoute, { method: "POST" });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Duplizieren fehlgeschlagen.");
      setBusy(null);
      return;
    }
    const j = (await res.json()) as { id: string };
    setBusy(null);
    closeMenu();
    if (duplicateRedirect) router.push(duplicateRedirect.replace("{id}", j.id));
    router.refresh();
  }

  async function cancel() {
    if (!cancelRoute) return;
    if (!confirm("Beleg wirklich stornieren?")) return;
    setBusy("CANCEL");
    setError(null);
    const res = await fetch(cancelRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cancelBody ?? {}),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Stornieren fehlgeschlagen.");
      setBusy(null);
      return;
    }
    setBusy(null);
    closeMenu();
    router.refresh();
  }

  /**
   * Legt eine Mahnung an (POST dunningRoute). `openSendAfter=true` (REMINDER): oeffnet
   * nach Erfolg den Versand-Dialog fuer die neue Mahnung, statt nur das Menue zu
   * schliessen (DUNNING-Verhalten). shouldForceDunningRetry() entscheidet den
   * force/confirm-Ablauf bei 409 (naechste Stufe noch nicht faellig).
   */
  async function createDunning(force: boolean, busyKey: "DUNNING" | "REMINDER", openSendAfter: boolean) {
    if (!dunningRoute) return;
    setBusy(busyKey);
    setError(null);
    const res = await fetch(dunningRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      const confirmed = !force && res.status === 409 ? confirm(`${j.error ?? "Noch nicht fällig."}\n\nTrotzdem jetzt erstellen?`) : false;
      if (shouldForceDunningRetry({ status: res.status, alreadyForced: force, confirmed })) {
        setBusy(null);
        return createDunning(true, busyKey, openSendAfter);
      }
      setError(j.error ?? "Mahnung konnte nicht erstellt werden.");
      setBusy(null);
      return;
    }
    const j = (await res.json()) as { dunningId: string };
    setBusy(null);
    if (openSendAfter) {
      setReminderDunningId(j.dunningId);
    } else {
      closeMenu();
    }
    router.refresh();
  }

  const has = (k: ActionKey) => actions.includes(k);

  return (
    <div className="flex items-center justify-end gap-1">
      {/* Task 7: Direktknoepfe fuer PDF/Zahlung vor dem "..."-Menue — bleiben zusaetzlich
          im Menue (unten), damit sich die Tastaturbedienung (Tab-Reihenfolge im Menue)
          nicht aendert. */}
      {has("PDF") && pdfHref && (
        <a href={pdfHref} target="_blank" className={directBtnCls}>
          PDF
        </a>
      )}
      {has("PAYMENT") && payment && (
        <button type="button" onClick={() => setPaymentOpen(true)} className={directBtnCls}>
          Zahlung
        </button>
      )}
      <details className="relative inline-block text-left" open={detailsOpen} onToggle={(e) => setDetailsOpen(e.currentTarget.open)}>
        <summary
          className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
          aria-label="Aktionen"
        >
          ⋯
        </summary>
        <div className="absolute right-0 z-20 mt-1 w-64 space-y-0.5 rounded-md border border-slate-200 bg-white p-1.5 shadow-lg">
          {has("OPEN") && (
            <Link href={openHref} className={linkCls} onClick={closeMenu}>
              Öffnen
            </Link>
          )}
          {has("EDIT") && editHref && (
            <Link href={editHref} className={linkCls} onClick={closeMenu}>
              Bearbeiten
            </Link>
          )}
          {has("PDF") && pdfHref && (
            <a href={pdfHref} target="_blank" className={linkCls} onClick={closeMenu}>
              PDF
            </a>
          )}
          {has("XRECHNUNG") && xrechnungHref && (
            <a href={xrechnungHref} target="_blank" className={linkCls} onClick={closeMenu}>
              XRechnung (XML)
            </a>
          )}
          {has("DUPLICATE") && duplicateRoute && (
            <button type="button" onClick={duplicate} disabled={busy === "DUPLICATE"} className={itemCls}>
              {busy === "DUPLICATE" ? "…" : "Duplizieren"}
            </button>
          )}
          {has("TEMPLATE_SAVE") && kind !== "RECURRING" && (
            <SaveTemplateDialog docType={kind as TagDocType} docId={id} defaultName={templateName} asMenuItem />
          )}
          {(has("SEND") || has("RESEND")) && emailDocType && (
            <div className={itemCls}>
              <SendEmailDialog docType={emailDocType} docId={id} label={hasEmailLog ? "Erneut senden" : "Per E-Mail senden"} />
            </div>
          )}
          {has("PAYMENT") && payment && (
            <div className="border-t border-slate-100 px-3 py-2">
              <p className="mb-1 text-xs font-medium text-slate-500">Zahlung erfassen</p>
              <PaymentForm invoiceId={id} openCents={payment.openCents} methods={payment.methods} defaultMethod={payment.defaultMethod} />
            </div>
          )}
          {/* Ruling (a): REMINDER legt eine Mahnung an und oeffnet danach IHREN
              Versand-Dialog (docType DUNNING) — niemals den Rechnungs-Versand-Dialog.
              Fix-Welle (Nit): REMINDER und DUNNING erstellen beide identisch per POST
              dunningRoute eine Mahnung (nur das Verhalten NACH dem Anlegen unterscheidet
              sich) — vorher wurden beide Buttons IMMER gleichzeitig angezeigt, was zwei
              unterschiedliche Labels fuer denselben Effekt suggerierte. Jetzt genau EIN
              Button: "Zahlungserinnerung senden" nur, solange noch keine Mahnung existiert
              (dunningCount 0 -> die anzulegende waere Stufe 0/die erste); sobald bereits
              mindestens eine existiert, "Nächste Mahnung erstellen" (reines DUNNING-
              Verhalten, kein Auto-Open des Versand-Dialogs). */}
          {has("REMINDER") && has("DUNNING") && dunningRoute ? (
            (dunningCount ?? 0) === 0 ? (
              <button type="button" onClick={() => createDunning(false, "REMINDER", true)} disabled={busy === "REMINDER"} className={itemCls}>
                {busy === "REMINDER" ? "…" : "Zahlungserinnerung senden"}
              </button>
            ) : (
              <button type="button" onClick={() => createDunning(false, "DUNNING", false)} disabled={busy === "DUNNING"} className={itemCls}>
                {busy === "DUNNING" ? "…" : "Nächste Mahnung erstellen"}
              </button>
            )
          ) : (
            <>
              {has("REMINDER") && dunningRoute && (
                <button type="button" onClick={() => createDunning(false, "REMINDER", true)} disabled={busy === "REMINDER"} className={itemCls}>
                  {busy === "REMINDER" ? "…" : "Zahlungserinnerung senden"}
                </button>
              )}
              {has("DUNNING") && dunningRoute && (
                <button type="button" onClick={() => createDunning(false, "DUNNING", false)} disabled={busy === "DUNNING"} className={itemCls}>
                  {busy === "DUNNING" ? "…" : "Mahnung erstellen"}
                </button>
              )}
            </>
          )}
          {reminderDunningId && (
            <SendEmailDialog key={reminderDunningId} docType="DUNNING" docId={reminderDunningId} label="Mahnung senden" autoOpen hideTrigger />
          )}
          {/* `!convert`: sobald der Aufrufer `convert` liefert (Task 8), zeigt die CONVERT-Zeile
              unten Lieferschein/AB/Rechnung gebuendelt — kein zweiter, engerer Lieferschein-Eintrag
              fuer denselben Beleg. Ohne `convert` (noch nicht verdrahtete Aufrufer) bleibt dieser
              Eintrag unveraendert bestehen. */}
          {has("DELIVERY_NOTE") && !convert && (kind === "QUOTE" || kind === "INVOICE") && (
            <div className={itemCls}>
              <ConvertMenu sourceType={kind} sourceId={id} showToDeliveryNote showToOrderConfirmation={false} showToInvoice={false} />
            </div>
          )}
          {has("CONVERT") && convert && (
            <ConvertMenu
              sourceType="QUOTE"
              sourceId={id}
              showToOrderConfirmation={convert.orderConfirmation}
              showToInvoice={convert.invoice}
              showToDeliveryNote={convert.deliveryNote}
              asMenuItem
            />
          )}
          {has("CANCEL") && cancelRoute && (
            <button type="button" onClick={cancel} disabled={busy === "CANCEL"} className={`${itemCls} text-rose-700 hover:bg-rose-50`}>
              {busy === "CANCEL" ? "…" : "Stornieren"}
            </button>
          )}
          {documentActions && (
            <ul className="space-y-0.5 border-t border-slate-100 pt-1">
              <DocumentActionsMenuItems type={documentActions.type} id={id} status={documentActions.status} archived={documentActions.archived} />
            </ul>
          )}
          {error && <p className="px-3 py-1 text-xs text-rose-600">{error}</p>}
        </div>
      </details>
      {has("PAYMENT") && payment && (
        <RowPaymentDialog open={paymentOpen} onClose={() => setPaymentOpen(false)} title="Zahlung erfassen">
          <PaymentForm invoiceId={id} openCents={payment.openCents} methods={payment.methods} defaultMethod={payment.defaultMethod} />
        </RowPaymentDialog>
      )}
    </div>
  );
}
