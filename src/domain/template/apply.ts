/**
 * Erzeugt aus einer Vorlage einen neuen Belegentwurf (Phase 13d, Task 3) — AUSSCHLIESSLICH
 * ueber createDraftInvoice/createBusinessDocument/createDeliveryNote: gleiche
 * Zod-Validierung, gleiche Steuersatz-Pruefung (assertAllowedTaxRates — bewusst OHNE
 * `inheritedTaxRates`, ein in der Vorlage gespeicherter, inzwischen gesperrter Steuersatz
 * wird NICHT still uebernommen), gleiche Snapshots und Nummernkreise wie ein regulaer
 * angelegter Beleg. Kein Bypass.
 *
 * `usageCount`/`lastUsedAt` werden NACH der Erzeugung in einem eigenen `update`
 * geschrieben: die Erzeugung wickelt ihre eigene Transaktion — ein fehlgeschlagener
 * Zaehler darf den bereits erzeugten Beleg nicht zurueckrollen, ein fehlgeschlagener
 * Beleg zaehlt nie hoch.
 */
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { createDraftInvoice } from "@/domain/invoice/create";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createInvoiceSchema } from "@/schemas";
import { documentTemplatePayloadSchema, applyTemplateSchema, type DocumentTemplatePayload } from "@/schemas/template";
import type { TagDocType } from "@/schemas/tag";

/** Weder die Anfrage noch die Vorlage noch der gespeicherte Payload nennen einen Kunden —
 *  ohne Empfaenger darf kein Beleg entstehen. */
export class TemplateCustomerRequiredError extends Error {}

function toDeliveryNoteLine(l: DocumentTemplatePayload["lines"][number]) {
  return {
    description: l.description,
    articleNumber: l.articleNumber,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    taxRate: l.taxRate,
  };
}

export async function applyTemplate(
  orgId: string,
  templateId: string,
  raw: unknown,
  actor = "system",
): Promise<{ docType: TagDocType; id: string }> {
  const input = applyTemplateSchema.parse(raw);
  const now = new Date();

  const tpl = await dbInternal.documentTemplate.findFirst({ where: { id: templateId, orgId } });
  if (!tpl) throw new NotFoundError(`Vorlage ${templateId} nicht gefunden.`);

  // Schema-Drift-sicher (koordinator-nachtrag.md): der beim Speichern bereits validierte
  // Payload wird beim Anwenden ERNEUT geparst, nicht dem gespeicherten JSON vertraut.
  const payload = documentTemplatePayloadSchema.parse(JSON.parse(tpl.payloadJson));
  const customerId = input.customerId ?? tpl.customerId ?? payload.customerId;
  if (!customerId) {
    throw new TemplateCustomerRequiredError("Ohne Kunde kann aus dieser Vorlage kein Beleg erzeugt werden.");
  }

  const docType = tpl.docType as TagDocType;
  let id: string;
  if (docType === "INVOICE") {
    const invoiceInput = createInvoiceSchema.parse({ ...payload, customerId });
    const invoice = await createDraftInvoice(orgId, invoiceInput, { actor, now });
    id = invoice.id;
  } else if (docType === "QUOTE") {
    const doc = await createBusinessDocument(orgId, { ...payload, customerId, kind: tpl.kind ?? "ANGEBOT" }, { actor, now });
    id = doc.id;
  } else {
    const note = await createDeliveryNote(
      orgId,
      {
        customerId,
        headerText: payload.headerText,
        footerText: payload.footerText,
        notes: payload.notes,
        lines: payload.lines.map(toDeliveryNoteLine),
      },
      { actor, now },
    );
    id = note.id;
  }

  // Eigener Schreibvorgang (siehe Modulkommentar): darf den bereits erzeugten Beleg im
  // Fehlerfall nicht zurueckrollen.
  await dbInternal.documentTemplate.update({
    where: { id: tpl.id },
    data: { usageCount: { increment: 1 }, lastUsedAt: now },
  });
  await logActivity(dbInternal, {
    orgId,
    entityType: docType,
    entityId: id,
    type: "TEMPLATE_APPLIED",
    actor,
    at: now,
    data: { templateId: tpl.id },
  });

  return { docType, id };
}
