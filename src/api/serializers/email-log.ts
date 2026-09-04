import { iso } from "./common";
import type { EmailLog } from "@/generated/prisma/client";

function parseJsonArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function serializeEmailLog(l: EmailLog) {
  return {
    objectName: "EmailLog" as const,
    id: l.id,
    docType: l.docType,
    docId: l.docId,
    templateId: l.templateId,
    to: parseJsonArray(l.toJson),
    cc: parseJsonArray(l.ccJson),
    bcc: parseJsonArray(l.bccJson),
    fromEmail: l.fromEmail,
    replyTo: l.replyTo,
    subject: l.subject,
    // bodySnapshot ist der volle E-Mail-Text (kein internes Notizfeld) — bewusst enthalten.
    body: l.bodySnapshot,
    attachments: parseJsonArray(l.attachmentsJson),
    status: l.status,
    providerId: l.providerId,
    error: l.error,
    warnings: parseJsonArray(l.warningsJson),
    resendOfId: l.resendOfId,
    sentByUserId: l.sentByUserId,
    sentAt: iso(l.sentAt),
    createdAt: iso(l.createdAt),
  };
}
