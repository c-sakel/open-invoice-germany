/**
 * Anlegen/Aendern/Loeschen von Belegvorlagen (Phase 13d, Task 3/4/5) — die Ableitung des
 * Payloads AUS einem gespeicherten Beleg ("Beleg -> Payload") sitzt seit Fix-Welle 1
 * (should 6: save.ts lag mit ihr bei 308 Zeilen, Konvention ~250) in
 * `src/domain/template/source.ts#loadSourcePayload`. Der Payload wird zusaetzlich mit
 * `documentTemplatePayloadSchema` validiert (zweite Verteidigungslinie neben der
 * Feldauswahl dort) und hier als JSON gespeichert.
 */
import { Prisma } from "@/generated/prisma/client";
import type { DocumentTemplate } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import {
  documentTemplateInputSchema,
  documentTemplateUpdateSchema,
  saveTemplateFromDocumentSchema,
} from "@/schemas/template";
import { loadSourcePayload } from "@/domain/template/source";

/** orgId/name ist eindeutig (DocumentTemplate.@@unique([orgId, name])) — statt des rohen
 *  Prisma-P2002-Fehlertexts eine fuer Anwender verstaendliche Meldung. */
export class TemplateNameConflictError extends Error {}

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
 * Legt eine Vorlage DIREKT an — ohne Quellbeleg (Phase 13d, Task 5, `POST
 * /api/v1/DocumentTemplate`). Anders als `saveTemplateFromDocument` (Payload aus einem
 * bestehenden Beleg abgeleitet) validiert `documentTemplateInputSchema` den kompletten
 * Payload direkt aus der Anfrage — `documentTemplatePayloadSchema` (darin enthalten)
 * bleibt dieselbe zweite Verteidigungslinie wie beim UI-Pfad. `entityType "TEMPLATE"`
 * wie `deleteTemplate`: es gibt keinen einzelnen Quellbeleg, auf den das Ereignis
 * zeigen koennte.
 */
export async function createTemplate(orgId: string, rawInput: unknown, actor = "system"): Promise<DocumentTemplate> {
  const input = documentTemplateInputSchema.parse(rawInput);
  const now = new Date();

  // Kunde muss zur Organisation gehoeren (Review-Fund Task 6, Phase 13d, Muster
  // src/domain/invoice/create.ts) — sonst koennte eine fremde Kunden-Id (andere Org)
  // unbemerkt in der Vorlage landen.
  if (input.customerId) {
    const customer = await dbInternal.customer.findFirst({ where: { id: input.customerId, orgId }, select: { id: true } });
    if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  }

  try {
    return await dbInternal.$transaction(async (tx) => {
      const created = await tx.documentTemplate.create({
        data: {
          orgId,
          name: input.name,
          docType: input.docType,
          kind: input.kind ?? null,
          customerId: input.customerId ?? null,
          payloadJson: JSON.stringify(input.payload),
        },
      });
      await logActivity(tx, { orgId, entityType: "TEMPLATE", entityId: created.id, type: "TEMPLATE_SAVED", actor, at: now, data: { name: input.name } });
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
 * Aktualisiert Name/Kunde/Payload einer Vorlage (Phase 13d, Task 5, `PATCH
 * /api/v1/DocumentTemplate/{id}`) — Teil-Update wie `documentTemplateUpdateSchema`
 * (jedes Feld optional, unbekannte Felder wirft `.strict()`). `docType`/`kind` sind
 * nicht Teil des Update-Schemas (bestimmen die Struktur eines bereits gespeicherten
 * Payloads) — nur `renameTemplate` deckt die reine Namensaenderung ab, dieses hier
 * zusaetzlich Kunde/Payload in einem Aufruf. Reine Metadatenaenderung wie
 * `renameTemplate`: kein neuer ActivityLog-Eintrag.
 */
export async function updateTemplate(orgId: string, id: string, rawInput: unknown): Promise<DocumentTemplate> {
  const input = documentTemplateUpdateSchema.parse(rawInput);
  // Kunde muss zur Organisation gehoeren (Review-Fund Task 6, Phase 13d) — wie
  // `createTemplate`; ein explizites `null` (Kunde entfernen) braucht keine Pruefung.
  if (input.customerId) {
    const customer = await dbInternal.customer.findFirst({ where: { id: input.customerId, orgId }, select: { id: true } });
    if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  }
  try {
    const tpl = await dbInternal.documentTemplate.findFirst({ where: { id, orgId } });
    if (!tpl) throw new NotFoundError(`Vorlage ${id} nicht gefunden.`);
    return await dbInternal.documentTemplate.update({
      where: { id: tpl.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...(input.payload !== undefined ? { payloadJson: JSON.stringify(input.payload) } : {}),
      },
    });
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
