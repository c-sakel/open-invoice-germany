/**
 * Vorlage aus einem gespeicherten Beleg (Phase 13d, Task 3) — liest AUSSCHLIESSLICH den
 * gespeicherten Beleg (dbInternal, nie einen Client-Entwurf), waehlt die Felder wie
 * src/domain/document/duplicate.ts, MINUS Belegnummer, Datum (issueDate/dueDate/
 * validUntil), Snapshots, Zahlungen/Mahndaten UND internalNotes (§48 — interne Notizen
 * duerfen nie in eine Vorlage gelangen, die spaeter einen neuen Beleg erzeugt). Der
 * Payload wird zusaetzlich mit `documentTemplatePayloadSchema` validiert (zweite
 * Verteidigungslinie neben der Feldauswahl hier) und als JSON gespeichert.
 */
import { Prisma } from "@/generated/prisma/client";
import type { DocumentTemplate } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { documentTemplatePayloadSchema, documentTemplateInputSchema, saveTemplateFromDocumentSchema, type DocumentTemplatePayload } from "@/schemas/template";
import type { TagDocType } from "@/schemas/tag";

/** orgId/name ist eindeutig (DocumentTemplate.@@unique([orgId, name])) — statt des rohen
 *  Prisma-P2002-Fehlertexts eine fuer Anwender verstaendliche Meldung. */
export class TemplateNameConflictError extends Error {}

interface SourcePayload {
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

async function loadSourcePayload(orgId: string, docType: TagDocType, docId: string): Promise<SourcePayload> {
  if (docType === "INVOICE") return loadInvoicePayload(orgId, docId);
  if (docType === "QUOTE") return loadQuotePayload(orgId, docId);
  return loadDeliveryNotePayload(orgId, docId);
}

/**
 * Speichert den aktuellen Stand eines gespeicherten Belegs als wiederverwendbare
 * Vorlage. `saveTemplateFromDocumentSchema` validiert die Eingabe (docType/docId/name),
 * `documentTemplatePayloadSchema` den daraus gebauten Payload — beide Boundaries laufen
 * unabhaengig voneinander (Lastenheft §50/§55).
 */
export async function saveTemplateFromDocument(orgId: string, raw: unknown, actor = "system"): Promise<DocumentTemplate> {
  const input = saveTemplateFromDocumentSchema.parse(raw);
  const now = new Date();
  const { payload, kind, customerId } = await loadSourcePayload(orgId, input.docType, input.docId);

  try {
    return await dbInternal.$transaction(async (tx) => {
      const created = await tx.documentTemplate.create({
        data: {
          orgId,
          name: input.name,
          docType: input.docType,
          kind,
          customerId,
          payloadJson: JSON.stringify(payload),
        },
      });
      await logActivity(tx, {
        orgId,
        entityType: input.docType,
        entityId: input.docId,
        type: "TEMPLATE_SAVED",
        actor,
        at: now,
        data: { templateId: created.id, name: input.name },
      });
      return created;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new TemplateNameConflictError("Es gibt bereits eine Vorlage mit diesem Namen.");
    }
    throw e;
  }
}

/**
 * Benennt eine Vorlage um (Phase 13d, Task 4 — Umbenennen auf /vorlagen). Reine
 * Metadatenaenderung: Payload/Kunde/docType/kind bleiben unveraendert, kein neuer
 * ActivityLog-Eintrag (Muster `saveTag`: nur das Loeschen protokolliert, siehe
 * `deleteTag`/`deleteTemplate` unten). `documentTemplateInputSchema.shape.name` traegt
 * dieselbe Laengengrenze wie beim Anlegen (max. 80 Zeichen) statt einer zweiten,
 * abweichenden Grenze hier.
 */
export async function renameTemplate(orgId: string, id: string, rawName: unknown): Promise<DocumentTemplate> {
  const name = documentTemplateInputSchema.shape.name.parse(rawName);
  try {
    const tpl = await dbInternal.documentTemplate.findFirst({ where: { id, orgId } });
    if (!tpl) throw new NotFoundError(`Vorlage ${id} nicht gefunden.`);
    return await dbInternal.documentTemplate.update({ where: { id: tpl.id }, data: { name } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new TemplateNameConflictError("Es gibt bereits eine Vorlage mit diesem Namen.");
    }
    throw e;
  }
}

/**
 * Loescht eine Vorlage (Phase 13d, Task 4 — Koordinator-Nachtrag: VOR der Oberflaeche in
 * einem eigenen Commit). Eine Vorlage ist reine Metadaten, kein GoBD-Belegbestandteil
 * (Modulkommentar) — das Loeschen ruehrt keinen mit ihr bereits erzeugten Beleg an, nur
 * die Vorlage selbst verschwindet (kein ChangeLog-Eintrag, nur das unverkettete
 * ActivityLog, Audit K5). Org-Isolation wie `applyTemplate`: eine fremde/unbekannte id
 * wirft `NotFoundError` (dasselbe Muster, kein eigener TemplateNotFoundError noetig).
 */
export async function deleteTemplate(orgId: string, id: string, actor = "system"): Promise<void> {
  const now = new Date();
  await dbInternal.$transaction(async (tx) => {
    const tpl = await tx.documentTemplate.findFirst({ where: { id, orgId } });
    if (!tpl) throw new NotFoundError(`Vorlage ${id} nicht gefunden.`);
    await tx.documentTemplate.delete({ where: { id: tpl.id } });
    await logActivity(tx, { orgId, entityType: "TEMPLATE", entityId: tpl.id, type: "TEMPLATE_DELETED", actor, at: now, data: { name: tpl.name } });
  });
}
