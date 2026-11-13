/**
 * Phase 17b (vorher Fix-Welle 1, M1): Lieferscheine haben einen Entwurfspfad, ein Upload VOR
 * dem Erstellen legt nur einen Entwurf an. Reine Funktionspruefung (kein RTL im Projekt, siehe
 * test/unit/editor-discount-mode.test.ts fuer dasselbe Muster): `canOfferAttachmentUpload`
 * entscheidet, ob `AttachmentsBlock` den Upload-Weg (ggf. inkl. `ensureDocId`) ueberhaupt
 * anbietet. Liefert sie `false`, rendert `AttachmentsBlock` nur den Hinweistext — es gibt
 * dann gar keinen Datei-Input und keinen `ensureDocId`-Aufruf, also auch keinen Weg zu
 * `POST /api/delivery-notes` (die Domaenenwirkung von Uploads NACH dem Speichern deckt
 * test/integration/editor-attachments.test.ts bereits fuer INVOICE ab).
 */
import { describe, it, expect } from "vitest";
import { canOfferAttachmentUpload } from "@/components/editor/blocks/AttachmentsBlock";

describe("AttachmentsBlock.canOfferAttachmentUpload (Phase 17b)", () => {
  it("DELIVERY_NOTE ohne docId: Upload erlaubt (ensureDocId legt einen Entwurf an)", () => {
    expect(canOfferAttachmentUpload("DELIVERY_NOTE", undefined)).toBe(true);
    expect(canOfferAttachmentUpload("DELIVERY_NOTE", "")).toBe(true);
  });
  it("DELIVERY_NOTE MIT docId: Upload erlaubt", () => {
    expect(canOfferAttachmentUpload("DELIVERY_NOTE", "dn1")).toBe(true);
  });
  it("INVOICE/DOCUMENT bieten den Upload-Weg auch VOR dem Speichern an", () => {
    expect(canOfferAttachmentUpload("INVOICE", undefined)).toBe(true);
    expect(canOfferAttachmentUpload("DOCUMENT", undefined)).toBe(true);
    expect(canOfferAttachmentUpload("INVOICE", "inv1")).toBe(true);
  });
});
