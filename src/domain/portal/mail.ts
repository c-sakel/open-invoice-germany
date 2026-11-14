/**
 * Portal-Link per E-Mail an den Kunden senden. Empfaenger: explizit > Rechnungs-E-Mail > E-Mail des Kunden.
 * Betreff und Text kommen aus den Portal-Einstellungen (mit Platzhaltern) oder aus dem eingebauten Text in der
 * Sprache des Kunden. Protokoll wie beim Belegversand (EmailLog QUEUED -> SENT/FAILED); das ActivityLog enthaelt
 * nie die URL oder das Token.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { createQueuedEmailLog, finishEmailLog } from "@/domain/email/email-log";
import { withHtmlPart } from "@/domain/email/html-part";
import { loadMailSettings, MailNotConfiguredError } from "@/domain/email/settings";
import { PortalError } from "@/domain/portal/errors";
import { getPortalLinkStatus, revealPortalUrl } from "@/domain/portal/link";
import { loadPortalSettings } from "@/domain/portal/settings";
import { RateLimitError } from "@/lib/rate-limit";
import { resolveDocLanguage, type DocLanguage } from "@/lib/i18n/doc";
import { createSmtpProvider } from "@/lib/mail/smtp";
import type { MailProvider } from "@/lib/mail/provider";
import { formatDateLang } from "@/lib/template/format";
import { renderTemplate, type TemplateContext } from "@/lib/template/render";

export const PORTAL_MAIL_DOC_TYPE = "PORTAL";
/** Hoechstens so viele Portal-Mails je Kunde und Stunde (Schutz vor Mailflut und Doppelversand). */
export const PORTAL_MAIL_MAX_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

const recipientSchema = z.string().trim().email().max(254);

export interface SendPortalLinkResult {
  logId: string;
  status: "SENT" | "FAILED";
  to: string;
  error?: string;
}

const BUILT_IN: Record<DocLanguage, { subject: string; body: string }> = {
  de: {
    subject: "Ihr Kundenportal bei {{company.name}}",
    body: [
      "Guten Tag {{customer.name}},",
      "",
      "Ihre Rechnungen und weiteren Belege finden Sie in Ihrem Kundenportal:",
      "{{portal.url}}",
      "",
      "Der Link ist gültig bis {{portal.validUntil}}.",
      "",
      "Freundliche Grüße",
      "{{company.name}}",
    ].join("\n"),
  },
  en: {
    subject: "Your customer portal at {{company.name}}",
    body: [
      "Hello {{customer.name}},",
      "",
      "You can find your invoices and other documents in your customer portal:",
      "{{portal.url}}",
      "",
      "The link is valid until {{portal.validUntil}}.",
      "",
      "Kind regards",
      "{{company.name}}",
    ].join("\n"),
  },
};

export async function sendPortalLinkEmail(
  orgId: string,
  customerId: string,
  opts: { actor: string; to?: string; baseUrl: string; provider?: MailProvider; now?: Date },
): Promise<SendPortalLinkResult> {
  const now = opts.now ?? new Date();
  const customer = await dbInternal.customer.findFirst({
    where: { id: customerId, orgId },
    select: { id: true, name: true, email: true, invoiceEmail: true, language: true, isArchived: true },
  });
  if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  if (customer.isArchived) throw new PortalError("Der Kunde ist archiviert.", "CUSTOMER_ARCHIVED");

  const explicit = opts.to?.trim();
  const toRaw = explicit || customer.invoiceEmail?.trim() || customer.email?.trim() || "";
  if (!toRaw) throw new PortalError("Für den Kunden ist keine E-Mail-Adresse hinterlegt.", "NO_RECIPIENT");
  const to = recipientSchema.parse(toRaw);

  const portal = await loadPortalSettings(orgId);
  if (!portal.enabled) throw new PortalError("Das Kundenportal ist nicht aktiviert.", "PORTAL_DISABLED");
  const status = await getPortalLinkStatus(orgId, customerId, now);
  const url = status?.active ? await revealPortalUrl(orgId, customerId, opts.baseUrl, now) : null;
  if (!status || !url) throw new PortalError("Es gibt keinen aktiven Portal-Link. Zuerst einen Link anlegen.", "NO_ACTIVE_LINK");

  const settings = await loadMailSettings(orgId);
  if (!settings) throw new MailNotConfiguredError();

  // Cooldown je Kunde ueber das Versandprotokoll (ueberlebt Neustarts); Zeitbasis ist die Echtzeit,
  // weil EmailLog.createdAt vom Datenbankserver gesetzt wird.
  const since = new Date(Date.now() - HOUR_MS);
  const recent = await dbInternal.emailLog.findMany({
    where: { orgId, docType: PORTAL_MAIL_DOC_TYPE, docId: customerId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
    take: PORTAL_MAIL_MAX_PER_HOUR,
  });
  if (recent.length >= PORTAL_MAIL_MAX_PER_HOUR) {
    throw new RateLimitError(Math.max(recent[0]!.createdAt.getTime() + HOUR_MS - Date.now(), 1000));
  }
  const provider = opts.provider ?? createSmtpProvider(settings);

  const org = await dbInternal.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { legalName: true, email: true, phone: true, iban: true, bic: true },
  });
  const lang = resolveDocLanguage(customer.language);
  const ctx: TemplateContext = {
    customer: { name: customer.name, firstName: "", lastName: "", number: "", email: customer.email ?? "", customField: {} },
    company: { name: org.legalName, email: org.email ?? "", phone: org.phone ?? "", iban: org.iban ?? "", bic: org.bic ?? "" },
    portal: { url, validUntil: formatDateLang(status.expiresAt, lang) },
  };
  const builtIn = BUILT_IN[lang];
  const subject = renderTemplate(portal.mailSubject?.trim() || builtIn.subject, ctx).text.replace(/\s+/g, " ").trim().slice(0, 300);
  const text = renderTemplate(portal.mailBody?.trim() || builtIn.body, ctx).text;

  const log = await createQueuedEmailLog({
    orgId,
    docType: PORTAL_MAIL_DOC_TYPE,
    docId: customerId,
    fromEmail: settings.fromEmail,
    replyTo: settings.replyTo ?? null,
    to: [to],
    cc: [],
    bcc: [],
    subject,
    // Das Protokoll maskiert den Link zentral (createQueuedEmailLog).
    bodySnapshot: text,
    sentByUserId: opts.actor,
  });

  let result: "SENT" | "FAILED" = "SENT";
  let providerId: string | null = null;
  let error: string | undefined;
  let htmlSha256: string | undefined;
  try {
    const mail = await withHtmlPart(orgId, settings, {
      from: { name: settings.fromName, address: settings.fromEmail },
      to: [to],
      cc: [],
      bcc: [],
      replyTo: settings.replyTo ?? undefined,
      subject,
      text,
      attachments: [],
    }, { lang });
    if (mail.html !== undefined) htmlSha256 = createHash("sha256").update(mail.html).digest("hex");
    providerId = (await provider.send(mail)).providerId;
  } catch (e) {
    result = "FAILED";
    error = e instanceof Error ? e.message.slice(0, 500) : "Unbekannter Fehler";
  }

  await finishEmailLog({
    orgId,
    logId: log.id,
    status: result,
    providerId,
    error: error ?? null,
    actor: opts.actor,
    docType: PORTAL_MAIL_DOC_TYPE,
    docId: customerId,
    docNumber: null,
    to: [to],
    cc: [],
    bcc: [],
    subject,
    attachmentsMeta: [],
    htmlSha256,
    at: now,
  });

  if (result === "SENT") {
    await logActivity(dbInternal, {
      orgId,
      entityType: "CUSTOMER",
      entityId: customerId,
      type: "PORTAL_LINK_MAILED",
      actor: opts.actor,
      at: now,
      data: { linkId: status.id, to, emailLogId: log.id },
    });
  }
  return { logId: log.id, status: result, to, error };
}
