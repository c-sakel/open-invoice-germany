"use client";

import { useRef } from "react";
import { archiveCustomer } from "@/app/actions/masterdata";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";

/** "Archivieren" je Kundenzeile: erst nach Bestaetigung wird das Formular an die Server-Aktion gesendet. */
export function ArchiveCustomerButton({ id, name }: { id: string; name: string }) {
  const dialogRef = useRef<ConfirmDialogHandle>(null);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={formRef} action={archiveCustomer} className="inline">
        <input type="hidden" name="id" value={id} />
        <button type="button" onClick={() => dialogRef.current?.open()} className="inline-flex min-h-8 items-center text-xs text-ink-muted hover:text-stamp">
          Archivieren
        </button>
      </form>
      <ConfirmDialog
        ref={dialogRef}
        title="Kunde archivieren?"
        message={<>„{name}“ wird archiviert und nicht mehr zur Auswahl angeboten. Bestehende Belege bleiben unverändert.</>}
        confirmLabel="Archivieren"
        tone="danger"
        onConfirm={() => formRef.current?.requestSubmit()}
      />
    </>
  );
}
