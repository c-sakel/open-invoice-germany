"use client";

/**
 * Storno-Rueckfrage fuer Angebote, Auftragsbestaetigungen und Lieferscheine (T8).
 * Ersetzt `window.confirm`. Der Statuswechsel selbst laeuft weiter ueber die
 * Domain-Route (`setQuoteStatus`/`setDeliveryNoteStatus`, ChangeLog inklusive).
 */
import { forwardRef } from "react";
import {
  ConfirmDialog,
  type ConfirmDialogHandle,
} from "@/components/ui/ConfirmDialog";

export interface CancelDocumentInfo {
  /** Belegart im Titel, z. B. "Angebot", "Auftragsbestätigung", "Lieferschein". */
  noun: string;
  number?: string | null;
  /** Es existieren bereits Rechnungen zu diesem Beleg (Hinweis: bleiben bestehen). */
  linkedInvoices?: boolean;
}

export const CancelDocumentDialog = forwardRef<
  ConfirmDialogHandle,
  { info: CancelDocumentInfo; busy: boolean; onConfirm: () => void }
>(function CancelDocumentDialog({ info, busy, onConfirm }, ref) {
  const { noun, number, linkedInvoices } = info;
  return (
    <ConfirmDialog
      ref={ref}
      tone="danger"
      title={number ? `${noun} ${number} stornieren?` : `${noun} stornieren?`}
      confirmLabel="Stornieren"
      busy={busy}
      onConfirm={onConfirm}
      message={
        <div className="space-y-2">
          <p>
            Der Beleg wird auf „Storniert“ gesetzt. Das lässt sich nicht
            rückgängig machen.
          </p>
          {linkedInvoices && (
            <p className="text-amber-700">
              Bereits erstellte Rechnungen bleiben bestehen und müssen bei
              Bedarf einzeln storniert werden.
            </p>
          )}
        </div>
      }
    />
  );
});
