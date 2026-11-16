import "../openapi-zod-init";
import { z } from "zod";
import type { MailboxSettingsView } from "@/domain/mailbox/settings";
import type { InboundAttachmentRow } from "@/domain/mailbox/list";
import { INBOUND_ATTACHMENT_STATUSES } from "@/schemas/mailbox";
import { iso } from "./common";

/** Status des Postfachs; Passwort und voller Benutzername verlassen die Domain nie (`maskUser`). */
export function serializeMailboxStatus(v: MailboxSettingsView) {
  return {
    enabled: v.enabled,
    configured: Boolean(v.host && v.username && v.hasPassword),
    host: v.host,
    port: v.port,
    security: v.security,
    username: v.username,
    folder: v.folder,
    fetchSince: v.fetchSince,
    allowedSenderDomains: v.allowedSenderDomains,
    lastTestAt: iso(v.lastTestAt),
    lastTestOk: v.lastTestOk,
    lastTestError: v.lastTestError,
    lastRunAt: iso(v.lastRunAt),
    lastRunOk: v.lastRunOk,
    lastRunError: v.lastRunError,
    lastRunFetched: v.lastRunFetched,
    inbox: { count: v.inbox.count, bytes: v.inbox.bytes, quotaReached: v.inbox.quotaReached },
  };
}

export function serializeInboundMail(r: InboundAttachmentRow) {
  const preview = r.preview !== null && typeof r.preview === "object" && !Array.isArray(r.preview) ? (r.preview as Record<string, unknown>) : null;
  return {
    objectName: "InboundMail" as const,
    id: r.id,
    status: r.status,
    fileName: r.fileName,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    preview,
    mail: {
      internalDate: iso(r.receivedByMail.internalDate),
      fetchedAt: iso(r.receivedByMail.fetchedAt),
      senderDomain: r.receivedByMail.senderDomain,
      subject: r.receivedByMail.subject,
    },
    incomingInvoiceId: r.incomingInvoiceId,
    duplicateOfIncomingId: r.duplicateOfIncomingId,
    duplicateOfAttachmentId: r.duplicateOfAttachmentId,
    decidedAt: iso(r.decidedAt),
    decidedBy: r.decidedBy,
    discardReason: r.discardReason,
    purgedAt: iso(r.purgedAt),
    skipReason: r.skipReason,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

// ── OpenAPI-Schemas ──────────────────────────────────────────────────────────────
export const mailboxStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean().describe("Server, Benutzer und Passwort sind eingetragen (das Passwort wird nie ausgegeben)"),
  host: z.string().nullable(),
  port: z.number().int(),
  security: z.enum(["TLS", "STARTTLS"]),
  username: z.string().nullable().describe("Maskiert"),
  folder: z.string(),
  fetchSince: z.string().nullable().describe("Kalendertag; aeltere Mails werden nicht abgerufen"),
  allowedSenderDomains: z.array(z.string()),
  lastTestAt: z.string().nullable(),
  lastTestOk: z.boolean().nullable(),
  lastTestError: z.string().nullable().describe("Fester Fehlercode"),
  lastRunAt: z.string().nullable(),
  lastRunOk: z.boolean().nullable(),
  lastRunError: z.string().nullable().describe("Fester Fehlercode"),
  lastRunFetched: z.number().int(),
  inbox: z.object({ count: z.number().int(), bytes: z.number().int(), quotaReached: z.boolean() }),
});

export const inboundMailSchema = z.object({
  objectName: z.literal("InboundMail"),
  id: z.string(),
  status: z.enum(INBOUND_ATTACHMENT_STATUSES).describe("INBOX = zu sichten, ACCEPTED = uebernommen, DISCARDED = verworfen, DUPLICATE = Dublette, SKIPPED = uebersprungen"),
  fileName: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  preview: z.record(z.string(), z.unknown()).nullable().describe("Vorschau der Kopfdaten (nur Hinweis, nicht massgeblich)"),
  mail: z.object({
    internalDate: z.string().nullable(),
    fetchedAt: z.string().nullable(),
    senderDomain: z.string().nullable().describe("Nur die Domain; der Absender ist nicht geprueft"),
    subject: z.string().nullable(),
  }),
  incomingInvoiceId: z.string().nullable(),
  duplicateOfIncomingId: z.string().nullable(),
  duplicateOfAttachmentId: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  discardReason: z.string().nullable(),
  purgedAt: z.string().nullable(),
  skipReason: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
