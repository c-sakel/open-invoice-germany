/**
 * Vorlagenverwaltung (Lastenheft 17): Anlegen/Aktualisieren einer E-Mail-Vorlage.
 * `docType` ist nach dem Anlegen unveraendlich — bei einer Aktualisierung wird der
 * Wert serverseitig aus dem bestehenden Datensatz uebernommen, unabhaengig davon, was
 * der Aufrufer (Formular/API) mitschickt. Der clientseitige Schreibschutz im Formular
 * ist nur UX; diese Funktion ist die eigentliche Durchsetzung.
 */
import { dbInternal } from "@/lib/db";
import { emailTemplateInputSchema, type EmailTemplateInput, type EmailDocType } from "@/schemas/email";
import type { EmailTemplate } from "@/generated/prisma/client";

/** Legt eine Vorlage an oder aktualisiert sie. Wird `isDefault` gesetzt, werden alle
 *  anderen Vorlagen desselben Dokumenttyps in derselben Transaktion auf `false` gesetzt. */
export async function saveEmailTemplate(orgId: string, rawInput: EmailTemplateInput): Promise<EmailTemplate> {
  const input = emailTemplateInputSchema.parse(rawInput);

  return dbInternal.$transaction(async (tx) => {
    let templateId = input.id;
    let docType: EmailDocType = input.docType;

    if (templateId) {
      const existing = await tx.emailTemplate.findFirst({ where: { id: templateId, orgId } });
      if (!existing) throw new Error("Vorlage nicht gefunden.");
      // docType ist unveraenderlich: der bestehende Wert gewinnt, der Eingabewert wird ignoriert.
      docType = existing.docType as EmailDocType;
      await tx.emailTemplate.update({
        where: { id: templateId },
        data: {
          name: input.name,
          subject: input.subject,
          body: input.body,
          signature: input.signature ?? null,
          isDefault: input.isDefault,
        },
      });
    } else {
      const created = await tx.emailTemplate.create({
        data: {
          orgId,
          docType,
          name: input.name,
          subject: input.subject,
          body: input.body,
          signature: input.signature ?? null,
          isDefault: input.isDefault,
        },
      });
      templateId = created.id;
    }

    if (input.isDefault) {
      await tx.emailTemplate.updateMany({
        where: { orgId, docType, id: { not: templateId } },
        data: { isDefault: false },
      });
    }

    return tx.emailTemplate.findUniqueOrThrow({ where: { id: templateId } });
  });
}
