/**
 * Versand eines Belegs per E-Mail (Lastenheft 19/21): Protokoll (`EmailLog`) VOR dem
 * SMTP-Aufruf anlegen (Status QUEUED), damit bei einem Prozessabbruch waehrend des
 * Versands ein Log existiert; Ergebnis danach in EINER Transaktion mit dem ChangeLog-
 * Eintrag verbuchen. Kein SMTP-Aufruf innerhalb einer Prisma-Transaktion (SQLite-Sperre).
 *
 * Statuswerte hier nur QUEUED/SENT/FAILED — DELIVERED/BOUNCED setzt kein Provider-Webhook
 * (nicht Teil dieses Programms).
 */
import { createHash } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { buildStandardAttachments, type Attachment } from "@/domain/email/attachments";
import { loadMailSettings, MailNotConfiguredError } from "@/domain/email/settings";
import { createSmtpProvider } from "@/lib/mail/smtp";
import type { MailProvider } from "@/lib/mail/provider";
import type { SendEmailInput } from "@/schemas/email";

export interface SendDocumentEmailResult {
  logId: string;
  status: "SENT" | "FAILED";
  error?: string;
}

export async function sendDocumentEmail(
  orgId: string,
  actor: string,
  input: SendEmailInput,
  extra: Attachment[],
  provider?: MailProvider,
): Promise<SendDocumentEmailResult> {
  const settings = await loadMailSettings(orgId);
  if (!settings) throw new MailNotConfiguredError();
  const prov = provider ?? createSmtpProvider(settings);

  const std = await buildStandardAttachments(orgId, input.docType, input.docId);
  const attachments = [...std.filter((a) => input.standardAttachments.includes(a.filename)), ...extra];
  const bcc = input.copyToSelf && !input.bcc.includes(settings.fromEmail) ? [...input.bcc, settings.fromEmail] : input.bcc;
  const text = input.signature.trim() ? `${input.body}\n\n${input.signature}` : input.body;

  const attachmentsMeta = attachments.map((a) => ({
    filename: a.filename,
    size: a.content.length,
    sha256: createHash("sha256").update(a.content).digest("hex"),
  }));

  const log = await dbInternal.emailLog.create({
    data: {
      orgId,
      docType: input.docType,
      docId: input.docId,
      templateId: input.templateId ?? null,
      resendOfId: input.resendOfId ?? null,
      fromEmail: settings.fromEmail,
      replyTo: settings.replyTo ?? null,
      toJson: JSON.stringify(input.to),
      ccJson: JSON.stringify(input.cc),
      bccJson: JSON.stringify(bcc),
      subject: input.subject,
      bodySnapshot: text,
      attachmentsJson: JSON.stringify(attachmentsMeta),
      status: "QUEUED",
      warningsJson: "[]",
      sentByUserId: actor,
    },
  });

  let status: "SENT" | "FAILED" = "SENT";
  let providerId: string | null = null;
  let error: string | undefined;
  try {
    const res = await prov.send({
      from: { name: settings.fromName, address: settings.fromEmail },
      to: input.to,
      cc: input.cc,
      bcc,
      replyTo: settings.replyTo ?? undefined,
      subject: input.subject,
      text,
      attachments,
    });
    providerId = res.providerId;
  } catch (e) {
    status = "FAILED";
    error = e instanceof Error ? e.message.slice(0, 500) : "Unbekannter Fehler";
  }

  await dbInternal.$transaction(async (tx) => {
    await tx.emailLog.update({
      where: { id: log.id },
      data: { status, providerId, error: error ?? null, sentAt: status === "SENT" ? new Date() : null },
    });
    await appendChangeLog(tx, {
      orgId,
      entity: "EMAIL",
      entityId: log.id,
      action: status,
      actor,
      at: new Date(),
      diff: { docType: input.docType, docId: input.docId, to: input.to, cc: input.cc, bcc, subject: input.subject, attachments: attachmentsMeta, error: error ?? null },
    });
  });

  return { logId: log.id, status, error };
}
