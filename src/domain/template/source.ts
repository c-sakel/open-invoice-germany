/**
 * Vorlagen-Payload aus einem gespeicherten Beleg (Phase 13d, Task 3; Fix-Welle 1, should 6:
 * aus `save.ts` ausgegliedert — die drei `load*Payload`-Funktionen sind eine geschlossene
 * Einheit „Beleg -> Payload", `save.ts` (Konvention ~250 Zeilen) lag mit ihnen bei 308).
 * Liest AUSSCHLIESSLICH den gespeicherten Beleg (dbInternal, nie einen Client-Entwurf),
 * waehlt die Felder wie src/domain/document/duplicate.ts, MINUS Belegnummer, Datum
 * (issueDate/dueDate/validUntil), Snapshots, Zahlungen/Mahndaten UND internalNotes (§48 —
 * interne Notizen duerfen nie in eine Vorlage gelangen, die spaeter einen neuen Beleg
 * erzeugt). Der Payload wird zusaetzlich mit `documentTemplatePayloadSchema` validiert
 * (zweite Verteidigungslinie neben der Feldauswahl hier) und in `save.ts` als JSON
 * gespeichert.
 */
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { documentTemplatePayloadSchema, type DocumentTemplatePayload } from "@/schemas/template";
import type { TagDocType } from "@/schemas/tag";

export interface SourcePayload {
  payload: DocumentTemplatePayload;
  kind: string | null;
  customerId: string;
}

async function loadInvoicePayload(orgId: string, docId: string): Promise<SourcePayload> {
  const src = await dbInternal.invoice.findFirst({
    where: { id: docId, orgId },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!src) throw new NotFoundError(`Rechnung ${docId} nicht gefunden.`);

  const payload = documentTemplatePayloadSchema.parse({
    customerId: src.customerId,
    currency: src.currency,
    taxScheme: src.taxScheme,
    subject: src.subject ?? undefined,
    headerText: src.headerText ?? undefined,
    footerText: src.footerText ?? undefined,
    notes: src.notes ?? undefined,
    paymentTerms: src.paymentTerms ?? undefined,
    paymentMethodId: src.paymentMethodId ?? undefined,
    documentDiscountPermille: src.documentDiscountPermille,
    documentDiscountCents: src.documentDiscountCents,
    documentChargePermille: src.documentChargePermille,
    documentChargeCents: src.documentChargeCents,
    documentChargeReason: src.documentChargeReason ?? undefined,
    skonto1Permille: src.skonto1Permille ?? undefined,
    skonto1Days: src.skonto1Days ?? undefined,
    skonto2Permille: src.skonto2Permille ?? undefined,
    skonto2Days: src.skonto2Days ?? undefined,
    lines: src.lines.map((l) => ({
      lineType: l.lineType,
      description: l.description,
      descriptionLong: l.descriptionLong ?? undefined,
      articleNumber: l.articleNumber ?? undefined,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
    })),
  });
  return { payload, kind: null, customerId: src.customerId };
}

async function loadQuotePayload(orgId: string, docId: string): Promise<SourcePayload> {
  const src = await dbInternal.quote.findFirst({
    where: { id: docId, orgId },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!src) throw new NotFoundError(`Dokument ${docId} nicht gefunden.`);

  const payload = documentTemplatePayloadSchema.parse({
    customerId: src.customerId,
    currency: src.currency,
    taxScheme: src.taxScheme,
    subject: src.subject ?? undefined,
    headerText: src.headerText ?? undefined,
    footerText: src.footerText ?? undefined,
    notes: src.notes ?? undefined,
    paymentTerms: src.paymentTerms ?? undefined,
    deliveryTerms: src.deliveryTerms ?? undefined,
    documentDiscountPermille: src.documentDiscountPermille,
    documentDiscountCents: src.documentDiscountCents,
    documentChargePermille: src.documentChargePermille,
    documentChargeCents: src.documentChargeCents,
    documentChargeReason: src.documentChargeReason ?? undefined,
    lines: src.lines.map((l) => ({
      lineType: l.lineType,
      description: l.description,
      descriptionLong: l.descriptionLong ?? undefined,
      articleNumber: l.articleNumber ?? undefined,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
    })),
  });
  return { payload, kind: src.kind, customerId: src.customerId };
}

async function loadDeliveryNotePayload(orgId: string, docId: string): Promise<SourcePayload> {
  const src = await dbInternal.deliveryNote.findFirst({
    where: { id: docId, orgId },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!src) throw new NotFoundError(`Lieferschein ${docId} nicht gefunden.`);

  // DeliveryNoteLine kennt weder lineType (nur ITEM-Positionen) noch taxCategory/
  // discount* — invoiceLineInputSchema vergibt hier die Defaults (ITEM/S/0/0).
  const payload = documentTemplatePayloadSchema.parse({
    customerId: src.customerId,
    headerText: src.headerText ?? undefined,
    footerText: src.footerText ?? undefined,
    notes: src.notes ?? undefined,
    lines: src.lines.map((l) => ({
      description: l.description,
      articleNumber: l.articleNumber ?? undefined,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents ?? 0,
      taxRate: l.taxRate ?? 0,
    })),
  });
  return { payload, kind: null, customerId: src.customerId };
}

export async function loadSourcePayload(orgId: string, docType: TagDocType, docId: string): Promise<SourcePayload> {
  if (docType === "INVOICE") return loadInvoicePayload(orgId, docId);
  if (docType === "QUOTE") return loadQuotePayload(orgId, docId);
  return loadDeliveryNotePayload(orgId, docId);
}
