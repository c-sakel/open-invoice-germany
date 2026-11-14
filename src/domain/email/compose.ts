/**
 * Vorbelegung eines Versand-Dialogs (Lastenheft 19): Empfaenger, Betreff/Text aus Vorlage
 * gerendert, Standardanhaenge, sowie das erneute Vorbelegen aus einem bestehenden
 * `EmailLog` (Wiederversand).
 */
import { dbInternal } from "@/lib/db";
import { buildTemplateContext, DocumentNotFoundError } from "@/domain/email/context";
import { buildStandardAttachments, attachmentDocTypeFor, defaultStandardAttachmentFilenames, customerEInvoicePreferred } from "@/domain/email/attachments";
import { listAttachments } from "@/domain/attachment/manage";
import { loadMailSettings, MailNotConfiguredError } from "@/domain/email/settings";
import { loadDocumentSettings } from "@/domain/document/settings";
import { ensureOrgEmailTemplates } from "@/domain/masterdata/ensure";
import { DEFAULT_DUNNING_STAGES, EN_DUNNING_TEMPLATE_NAME_BY_ORDER } from "@/domain/masterdata/defaults";
import { resolveDocLanguage, type DocLanguage } from "@/lib/i18n/doc";
import { renderTemplate } from "@/lib/template/render";
import { revealShareLinkToken, createShareLink } from "@/domain/quote-share/link";
import { effectiveQuoteStatus } from "@/domain/document/status";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { PORTAL_LINK_MARKER, restorePortalLinks } from "@/domain/portal/mask";
import { revealPortalUrl } from "@/domain/portal/link";
import type { EmailDocType } from "@/schemas/email";

export interface PrefillSource {
  docType: EmailDocType;
  docId: string;
  /** Vorlage explizit waehlen statt Default/Mahnstufen-Logik. */
  templateId?: string;
}

export interface PrefillResult {
  docType: EmailDocType;
  docId: string;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  signature: string;
  copyToSelf: boolean;
  attachments: { filename: string; size: number }[];
  /** Dateinamen der standardmaessig vorausgewaehlten Anhaenge (eInvoiceDefault, Phase 7). */
  defaultStandardAttachments: string[];
  /** Bestehende Beleganhaenge (Phase 4b, DocumentAttachment) — zusaetzlich zu den
   *  automatischen Standardanhaenge oben waehlbar (sendEmailInputSchema.attachmentIds). */
  documentAttachments: { id: string; filename: string; sizeBytes: number }[];
  warnings: string[];
  templateId?: string;
  resendOfId?: string;
  templates: { id: string; name: string }[];
}

/** Wandelt eine kommagetrennte, bereits normalisierte Adressliste (aus MailSettings) in ein Array. */
function splitAddresses(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Ermittelt die URL fuer `{{offer.link}}` beim Vorbelegen einer ANGEBOT-Mail (Phase 3b,
 * Adjudikation Task-1). Ohne `APP_BASE_URL` bleibt der Platzhalter leer (Ruling). Per
 * Default wird KEIN neuer Link erzeugt (das war die urspruengliche W3-Luecke: jeder
 * Aufruf minte einen weiteren Link) — stattdessen wird der aktivste gueltige bestehende
 * Link wiederverwendet (`revokedAt` null, `decidedAt` null, `expiresAt` in der Zukunft,
 * Angebotsstatus effektiv DRAFT/SENT/EXPIRED) und dessen Token authentifiziert ueber
 * `revealShareLinkToken` entschluesselt.
 *
 * Phase 7 Fix-Runde 1: existiert kein solcher Link UND ist `DocumentSettings.
 * shareLinkDefaultOn` aktiv, wird jetzt HIER (statt beim eigentlichen Versand,
 * `sendDocumentEmail`) automatisch einer erzeugt — nur so kann der frisch erzeugte Link
 * noch in den {{offer.link}}-Platzhalter der ERSTEN Mail einfliessen, die aus dieser
 * Vorbelegung entsteht (der Mailtext wird hier gerendert, nicht erst beim Versand). Ist
 * die Einstellung aus, bleibt der Platzhalter wie zuvor leer — der Betreiber erzeugt den
 * Link bewusst ueber das Link-Panel.
 */
async function resolveOfferLink(orgId: string, docType: EmailDocType, docId: string): Promise<string | undefined> {
  if (docType !== "ANGEBOT") return undefined;
  const baseUrl = appBaseUrlFromEnv();
  if (!baseUrl) return undefined;

  const now = new Date();
  const quote = await dbInternal.quote.findFirst({ where: { id: docId, orgId }, select: { status: true, validUntil: true } });
  if (!quote) return undefined;
  const eff = effectiveQuoteStatus({ status: quote.status, validUntil: quote.validUntil }, now);
  if (eff !== "DRAFT" && eff !== "SENT" && eff !== "EXPIRED") return undefined;

  const link = await dbInternal.quoteShareLink.findFirst({
    where: { orgId, quoteId: docId, revokedAt: null, decidedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (link) {
    const token = await revealShareLinkToken(orgId, link.id);
    if (!token) return undefined;
    return `${baseUrl}/angebot/${token}`;
  }

  const settings = await loadDocumentSettings(orgId);
  if (!settings.shareLinkDefaultOn) return undefined;
  try {
    const created = await createShareLink(orgId, docId, {}, { actor: "system", now });
    return `${baseUrl}/angebot/${created.token}`;
  } catch (e) {
    console.warn("resolveOfferLink: shareLinkDefaultOn-Linkerzeugung fehlgeschlagen", e);
    return undefined;
  }
}

async function portalUrlForLog(orgId: string, docType: string, docId: string, text: string): Promise<string | null> {
  if (!text.includes(PORTAL_LINK_MARKER)) return null;
  try {
    if (docType === "PORTAL") {
      const baseUrl = appBaseUrlFromEnv();
      return baseUrl ? await revealPortalUrl(orgId, docId, baseUrl) : null;
    }
    const { ctx } = await buildTemplateContext(orgId, docType as EmailDocType, docId);
    return ctx.portal?.url || null;
  } catch {
    return null;
  }
}

async function templatesOf(orgId: string, docType: EmailDocType) {
  return dbInternal.emailTemplate.findMany({
    where: { orgId, docType },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** Belegsprache des Dokuments (Snapshot am Beleg); unbekannte Dokumente fallen auf Deutsch. */
async function docLanguageOf(orgId: string, docType: EmailDocType, docId: string): Promise<DocLanguage> {
  let code: string | undefined;
  if (docType === "INVOICE" || docType === "CREDIT_NOTE") {
    code = (await dbInternal.invoice.findFirst({ where: { id: docId, orgId }, select: { language: true } }))?.language;
  } else if (docType === "DELIVERY_NOTE") {
    code = (await dbInternal.deliveryNote.findFirst({ where: { id: docId, orgId }, select: { language: true } }))?.language;
  } else if (docType === "DUNNING") {
    code = (await dbInternal.dunning.findFirst({ where: { id: docId, invoice: { orgId } }, select: { language: true } }))?.language;
  } else {
    code = (await dbInternal.quote.findFirst({ where: { id: docId, orgId }, select: { language: true } }))?.language;
  }
  return resolveDocLanguage(code);
}

/** Waehlt die Vorlage fuer eine Mahnung. Deutsch: 1) `stage.emailTemplateId` (direkt an der
 *  Stufe hinterlegt), 2) Fallback ueber den NAMEN der Stufe (Phase 6: Stufen sind frei
 *  konfigurierbar, `stage.name` statt der fest verdrahteten `DEFAULT_DUNNING_STAGES`-Liste
 *  — sonst faende eine umbenannte/eigene Stufe nie ihre Vorlage), 3) irgendeine
 *  DUNNING-Vorlage. Andere Belegsprache (Phase 16b): zuerst die Stufenvorlage, falls sie
 *  selbst in dieser Sprache vorliegt, sonst gleichnamige Vorlage bzw. englische
 *  Systemvorlage der Stufe, sonst Standard der Sprache, zuletzt die deutsche Kette. */
async function pickDunningTemplate(orgId: string, docId: string, language: DocLanguage) {
  const d = await dbInternal.dunning.findFirst({
    where: { id: docId, invoice: { orgId } },
    include: { stage: { include: { emailTemplate: true } } },
  });
  const stageName = d?.stage?.name ?? DEFAULT_DUNNING_STAGES.find((s) => s.order === d?.level)?.name;

  if (language !== "de") {
    if (d?.stage?.emailTemplate?.language === language) return d.stage.emailTemplate;
    const names = [stageName, EN_DUNNING_TEMPLATE_NAME_BY_ORDER[d?.stage?.order ?? d?.level ?? -1]].filter((n): n is string => Boolean(n));
    for (const name of names) {
      const byName = await dbInternal.emailTemplate.findFirst({ where: { orgId, docType: "DUNNING", language, name } });
      if (byName) return byName;
    }
    const langDefault = await dbInternal.emailTemplate.findFirst({ where: { orgId, docType: "DUNNING", language, isDefault: true }, orderBy: { createdAt: "asc" } });
    if (langDefault) return langDefault;
  }

  if (d?.stage?.emailTemplate) return d.stage.emailTemplate;
  if (stageName) {
    const byName = await dbInternal.emailTemplate.findFirst({ where: { orgId, docType: "DUNNING", language: "de", name: stageName } });
    if (byName) return byName;
  }
  return dbInternal.emailTemplate.findFirst({
    where: { orgId, docType: "DUNNING", language: "de" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

async function pickTemplate(orgId: string, docType: EmailDocType, docId: string, templateId?: string) {
  if (templateId) {
    const explicit = await dbInternal.emailTemplate.findFirst({ where: { id: templateId, orgId, docType } });
    if (explicit) return explicit;
  }
  const language = await docLanguageOf(orgId, docType, docId);
  if (docType === "DUNNING") return pickDunningTemplate(orgId, docId, language);
  // Auswahl: (docType, Belegsprache, Standard) -> (docType, de, Standard).
  const inLanguage = await dbInternal.emailTemplate.findFirst({ where: { orgId, docType, language, isDefault: true }, orderBy: { createdAt: "asc" } });
  if (inLanguage || language === "de") return inLanguage;
  return dbInternal.emailTemplate.findFirst({ where: { orgId, docType, language: "de", isDefault: true }, orderBy: { createdAt: "asc" } });
}

/** Baut die Vorbelegung entweder aus einem Beleg (docType/docId) oder aus einem
 *  bestehenden Versandprotokoll (logId, fuer den Wiederversand). */
export async function prefillEmail(orgId: string, source: PrefillSource | { logId: string }): Promise<PrefillResult> {
  const settings = await loadMailSettings(orgId);
  if (!settings) throw new MailNotConfiguredError();
  const from = { name: settings.fromName, address: settings.fromEmail };
  const docSettings = await loadDocumentSettings(orgId);

  if ("logId" in source) {
    // G7: findFirst statt findFirstOrThrow — ein unbekanntes/fremdes logId ist kein
    // Serverfehler, sondern ein regulaerer 404-Fall (Route mappt DocumentNotFoundError).
    const log = await dbInternal.emailLog.findFirst({ where: { id: source.logId, orgId } });
    if (!log) throw new DocumentNotFoundError("Versandprotokoll nicht gefunden");
    const docType = log.docType as EmailDocType;
    // Das Protokoll traegt statt der Portal-URL den Platzhalter; beim Wiederversand wird der Link
    // neu aus dem aktuell aktiven Portal-Link des Kunden eingesetzt (leer, wenn es keinen gibt).
    const portalUrl = await portalUrlForLog(orgId, docType, log.docId, log.subject + log.bodySnapshot);
    const attachments = await buildStandardAttachments(orgId, docType, log.docId);
    const documentAttachments = (await listAttachments(orgId, attachmentDocTypeFor(docType), log.docId)).map((a) => ({
      id: a.id,
      filename: a.filename,
      sizeBytes: a.sizeBytes,
    }));
    // §28: Kundenvorgabe eInvoicePreferred kann die Org-Vorbelegung nur EINSCHALTEN, nie ausschalten.
    const eInvoiceDefault = docSettings.eInvoiceDefault || ((await customerEInvoicePreferred(orgId, docType, log.docId)) ?? false);
    return {
      docType,
      docId: log.docId,
      from,
      to: JSON.parse(log.toJson) as string[],
      cc: JSON.parse(log.ccJson) as string[],
      bcc: JSON.parse(log.bccJson) as string[],
      subject: restorePortalLinks(log.subject, portalUrl),
      body: restorePortalLinks(log.bodySnapshot, portalUrl),
      signature: "",
      copyToSelf: settings.copyToSelf,
      attachments: attachments.map((a) => ({ filename: a.filename, size: a.content.length })),
      defaultStandardAttachments: defaultStandardAttachmentFilenames(attachments, eInvoiceDefault),
      documentAttachments,
      warnings: [],
      templateId: log.templateId ?? undefined,
      resendOfId: log.id,
      templates: await templatesOf(orgId, docType),
    };
  }

  const { docType, docId, templateId } = source;
  const offerLink = await resolveOfferLink(orgId, docType, docId);
  const { ctx, customerEmail, customerCc } = await buildTemplateContext(orgId, docType, docId, { offerLink });

  let template = await pickTemplate(orgId, docType, docId, templateId);
  if (!template) {
    await ensureOrgEmailTemplates(dbInternal, orgId);
    template = await pickTemplate(orgId, docType, docId, templateId);
  }

  const warnings: string[] = [];
  let subject = "";
  let body = "";
  let signature = "";
  if (template) {
    const subj = renderTemplate(template.subject, ctx);
    // Ohne ermittelbare Angebots-URL bleibt der Platzhalter nicht als leere Stelle im
    // Fliesstext stehen ("Sie koennen das Angebot hier einsehen: ") — stattdessen wird
    // die komplette Zeile mit `{{offer.link}}` VOR dem Rendern entfernt.
    let rawBody = template.body;
    if (docType === "ANGEBOT" && !offerLink && /\{\{\s*offer\.link\s*\}\}/.test(rawBody)) {
      rawBody = rawBody
        .split("\n")
        .filter((line) => !/\{\{\s*offer\.link\s*\}\}/.test(line))
        .join("\n");
    }
    const bod = renderTemplate(rawBody, ctx);
    subject = subj.text;
    body = bod.text;
    warnings.push(...subj.warnings, ...bod.warnings);
    if (template.signature) {
      const sig = renderTemplate(template.signature, ctx);
      signature = sig.text;
      warnings.push(...sig.warnings);
    }
  }

  const attachments = await buildStandardAttachments(orgId, docType, docId);
  const documentAttachments = (await listAttachments(orgId, attachmentDocTypeFor(docType), docId)).map((a) => ({
    id: a.id,
    filename: a.filename,
    sizeBytes: a.sizeBytes,
  }));
  // §28: Kundenvorgabe eInvoicePreferred kann die Org-Vorbelegung nur EINSCHALTEN, nie ausschalten.
  const eInvoiceDefault = docSettings.eInvoiceDefault || ((await customerEInvoicePreferred(orgId, docType, docId)) ?? false);

  return {
    docType,
    docId,
    from,
    to: customerEmail ? [customerEmail] : [],
    // Phase 8a (§28): Customer.invoiceCc (nur INVOICE/CREDIT_NOTE/DUNNING) schlaegt den
    // Org-weiten Standard-CC vor; ohne Kundenvorgabe bleibt MailSettings.defaultCc der Fallback.
    cc: customerCc ? splitAddresses(customerCc) : splitAddresses(settings.defaultCc),
    bcc: splitAddresses(settings.defaultBcc),
    subject,
    body,
    signature,
    copyToSelf: settings.copyToSelf,
    attachments: attachments.map((a) => ({ filename: a.filename, size: a.content.length })),
    defaultStandardAttachments: defaultStandardAttachmentFilenames(attachments, eInvoiceDefault),
    documentAttachments,
    warnings,
    templateId: template?.id,
    templates: await templatesOf(orgId, docType),
  };
}
