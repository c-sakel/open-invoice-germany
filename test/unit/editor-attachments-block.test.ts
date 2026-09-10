/**
 * Fix-Welle 1, M1 (Abschluss-Review Phase 13b): DELIVERY_NOTE kennt anders als INVOICE/
 * DOCUMENT keinen Entwurfspfad — ein Anhang-Upload VOR dem Speichern darf dort deshalb
 * keinen Lieferschein anlegen. Reine Funktionspruefung (kein RTL im Projekt, siehe
 * test/unit/editor-discount-mode.test.ts fuer dasselbe Muster): `canOfferAttachmentUpload`
 * entscheidet, ob `AttachmentsBlock` den Upload-Weg (ggf. inkl. `ensureDocId`) ueberhaupt
 * anbietet. Liefert sie `false`, rendert `AttachmentsBlock` nur den Hinweistext — es gibt
 * dann gar keinen Datei-Input und keinen `ensureDocId`-Aufruf, also auch keinen Weg zu
 * `POST /api/delivery-notes` (die Domaenenwirkung von Uploads NACH dem Speichern deckt
 * test/integration/editor-attachments.test.ts bereits fuer INVOICE ab).
 */
import { describe, it, expect } from "vitest";
import { canOfferAttachmentUpload } from "@/components/editor/blocks/AttachmentsBlock";

describe("AttachmentsBlock.canOfferAttachmentUpload (Fix-Welle 1, M1)", () => {
  it("DELIVERY_NOTE ohne docId (Neuanlage, noch nicht gespeichert): kein Upload-Weg", () => {
    expect(canOfferAttachmentUpload("DELIVERY_NOTE", undefined)).toBe(false);
    expect(canOfferAttachmentUpload("DELIVERY_NOTE", "")).toBe(false);
  });
  it("DELIVERY_NOTE MIT docId (bereits gespeicherter Beleg): Upload erlaubt", () => {
    expect(canOfferAttachmentUpload("DELIVERY_NOTE", "dn1")).toBe(true);
  });
  it("INVOICE/DOCUMENT bieten den Upload-Weg auch VOR dem Speichern an (Entwurfspfad, Task 6)", () => {
    expect(canOfferAttachmentUpload("INVOICE", undefined)).toBe(true);
    expect(canOfferAttachmentUpload("DOCUMENT", undefined)).toBe(true);
    expect(canOfferAttachmentUpload("INVOICE", "inv1")).toBe(true);
  });
});
