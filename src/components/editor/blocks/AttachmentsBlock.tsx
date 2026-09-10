"use client";

/**
 * Anhaenge-Block (Phase 11c, Task 4; Phase 13b, Task 6): `AttachmentPanel` (bestehend)
 * rendert jetzt IMMER, auch bei Neuanlage — waehlt der Nutzer dort die erste Datei,
 * speichert `AttachmentPanel` (ueber `ensureDocId`) den Entwurf zuerst ueber den
 * bestehenden Entwurfs-Erzeugungspfad (`DocumentEditor.save`) und laedt danach ueber die
 * bestehende Route `POST /api/attachments` hoch — kein neuer Schreibpfad, kein
 * schwebender Datensatz. Der bisherige Hinweistext ("...nach dem Speichern...") lebt nur
 * noch als Fehlermeldung weiter, wenn das Speichern (Validierung) scheitert.
 *
 * `AttachmentPanel.docType` kennt keine eigene DOCUMENT-Unterscheidung nach Art
 * (Angebot/Auftragsbestaetigung/Proforma) — alle drei haengen wie heute
 * (`src/app/dokumente/[id]/page.tsx`) unter `"QUOTE"`.
 */
import type { EditorMode } from "@/lib/editor/constants";
import { AttachmentPanel, type AttachmentItem } from "@/components/AttachmentPanel";

const DOC_TYPE: Record<EditorMode, "QUOTE" | "INVOICE" | "DELIVERY_NOTE"> = {
  INVOICE: "INVOICE",
  DOCUMENT: "QUOTE",
  DELIVERY_NOTE: "DELIVERY_NOTE",
};

export function AttachmentsBlock({
  mode,
  docId,
  attachments = [],
  onEnsureDocId,
}: {
  mode: EditorMode;
  docId?: string;
  attachments?: AttachmentItem[];
  /** Neuanlage: speichert den Entwurf ueber den bestehenden Weg und liefert die neue
   *  Id (oder `null` bei fehlgeschlagener Validierung) — siehe `DocumentEditor.save`. */
  onEnsureDocId?: () => Promise<string | null>;
}) {
  return <AttachmentPanel docType={DOC_TYPE[mode]} docId={docId ?? ""} initial={attachments} ensureDocId={onEnsureDocId} />;
}
