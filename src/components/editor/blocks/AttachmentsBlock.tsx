"use client";

/**
 * Anhaenge-Block (Phase 11c, Task 4; Phase 13b, Task 6; Fix-Welle 1, M1): `AttachmentPanel`
 * (bestehend) rendert bei Neuanlage IMMER, ausser fuer DELIVERY_NOTE. Waehlt der Nutzer bei
 * INVOICE/DOCUMENT dort die erste Datei, speichert `AttachmentPanel` (ueber `ensureDocId`)
 * den Entwurf zuerst ueber den bestehenden Entwurfs-Erzeugungspfad (`DocumentEditor.save`,
 * `status: "DRAFT"`) und laedt danach ueber die bestehende Route `POST /api/attachments`
 * hoch — kein neuer Schreibpfad, kein schwebender Datensatz. Der bisherige Hinweistext
 * ("...nach dem Speichern...") lebt nur noch als Fehlermeldung weiter, wenn das Speichern
 * (Validierung) scheitert.
 *
 * M1 (Fix-Welle 1, Abschluss-Review Phase 13b): DELIVERY_NOTE kennt anders als INVOICE/
 * DOCUMENT KEINEN Entwurfspfad — `POST /api/delivery-notes` legt sofort einen
 * NUMMERIERTEN Beleg an (`assignDocumentNumber`, `status: "CREATED"`, ChangeLog +
 * ActivityLog, siehe `delivery-note/create.ts`). Ein Upload VOR dem eigentlichen
 * Speichern wuerde ueber `ensureDocId` also einen echten, unbeabsichtigten Lieferschein
 * anlegen; klickt der Nutzer danach trotzdem auf "Lieferschein anlegen", kennt
 * `performSave` im DELIVERY_NOTE-Zweig keinen PATCH-Pfad (immer POST) und legt einen
 * ZWEITEN, inhaltsgleichen Lieferschein mit der naechsten Nummer an. Deshalb bei
 * Neuanlage (kein `docId`) nur der alte Hinweistext, kein `ensureDocId`/Upload — Upload
 * ist erst nach dem Speichern moeglich (`docId` gesetzt, z. B. ueber eine kuenftige
 * Lieferschein-Detailseite mit Anhaengen).
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

/** M1 (Fix-Welle 1): ob der Block den Upload-Weg (ggf. ueber `ensureDocId`) ueberhaupt
 *  anbieten darf — ja, wenn bereits ein Beleg existiert (`docId` gesetzt, unabhaengig vom
 *  Modus), oder wenn der Modus einen Entwurfspfad kennt (INVOICE/DOCUMENT: `performSave`
 *  PATCHt beim zweiten Speichern denselben Beleg). DELIVERY_NOTE ohne `docId` liefert
 *  `false` — siehe Modulkommentar. Eigene, ungerenderte Funktion statt Inline-Bedingung,
 *  damit sie ohne Rendering testbar ist (kein RTL im Projekt, siehe
 *  test/unit/editor-layout.test.ts / test/unit/editor-discount-mode.test.ts fuer dasselbe
 *  Muster). */
export function canOfferAttachmentUpload(mode: EditorMode, docId?: string): boolean {
  return Boolean(docId) || mode !== "DELIVERY_NOTE";
}

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
  if (!canOfferAttachmentUpload(mode, docId)) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Anhänge lassen sich nach dem Speichern hinzufügen.</div>;
  }
  // Fuer DELIVERY_NOTE ist `docId` an dieser Stelle bereits gesetzt (siehe Guard oben) —
  // `ensureDocId` wird trotzdem explizit nicht durchgereicht (kein Auto-Anlegen-Pfad fuer
  // diesen Modus, M1-Ruling), statt sich implizit auf die docId-Praesenz zu verlassen.
  return <AttachmentPanel docType={DOC_TYPE[mode]} docId={docId ?? ""} initial={attachments} ensureDocId={mode === "DELIVERY_NOTE" ? undefined : onEnsureDocId} />;
}
