/**
 * Zahlungsbestaetigung per Mail (Aktion SEND_PAYMENT_CONFIRMATION). Nutzt den bestehenden Mailweg
 * (Vorlagen, Platzhalter, Protokoll, ChangeLog), ist aber KEIN Rechnungsversand: das Protokoll haengt
 * unter der Zahlung (docType PAYMENT_CONFIRMATION, docId = Zahlung), die Rechnung erhaelt weder
 * Versandstatus noch Versandprotokoll. Interne Notizen sind im Kontext nicht erreichbar.
 *
 * Ablauf: Vorpruefung (bereits gesendet / Ergebnis unbekannt) -> Text bauen -> unter der Kundensperre
 * Limits pruefen und das Protokoll (QUEUED) anlegen -> Versand ausserhalb jeder Transaktion -> Ergebnis
 * verbuchen. Ueber dem Limit wird der Lauf verschoben, nie verworfen.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { lockRow } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { logActivity } from "@/domain/activity/log";
import { buildTemplateContext, DocumentNotFoundError } from "@/domain/email/context";
import { loadMailSettings } from "@/domain/email/settings";
import { createQueuedEmailLog, finishEmailLog } from "@/domain/email/email-log";
import { withHtmlPart } from "@/domain/email/html-part";
import { createSmtpProvider } from "@/lib/mail/smtp";
import type { MailProvider } from "@/lib/mail/provider";
import { renderTemplate, type TemplateContext } from "@/lib/template/render";
import { formatDateLang, formatMoneyLang } from "@/lib/template/format";
import { resolveDocLanguage, type DocLanguage } from "@/lib/i18n/doc";
import { maskPortalLinks } from "@/domain/portal/mask";

export const PAYMENT_CONFIRMATION_DOC_TYPE = "PAYMENT_CONFIRMATION";
export const CONFIRMATION_MAX_PER_CUSTOMER_HOUR = 5;
export const CONFIRMATION_MAX_PER_ORG_HOUR = 100;
const HOUR_MS = 60 * 60_000;
const SUBJECT_MAX = 300;

export type ConfirmationOutcome =
  | { kind: "SENT"; logId: string }
  | { kind: "ALREADY"; logId: string }
  | { kind: "SKIPPED"; note: string }
  | { kind: "DEFER"; until: Date; note: string }
  /** `notSent`: sicher nichts an den Mailanbieter uebergeben (Claim darf freigegeben werden); sonst ist der Versand unklar. */
  | { kind: "FAILED"; error: string; retryable: boolean; notSent: boolean };

export const SEND_UNCLEAR_NOTE = "Versand unklar – E-Mail-Protokoll pruefen";

export interface ConfirmationRun {
  id: string;
  orgId: string;
  invoiceId: string;
  paymentId: string;
  customerId: string;
  contextJson: string;
  ruleId: string;
}

const contextSchema = z.object({
  amountCents: z.number().int(),
  paidAt: z.string(),
  openAfterCents: z.number().int(),
  currency: z.string(),
  invoiceNumber: z.string().nullable(),
});

const recipientSchema = z.string().trim().pipe(z.email());

const BUILT_IN: Record<DocLanguage, { full: { subject: string; body: string }; partial: { subject: string; body: string } }> = {
  de: {
    full: {
      subject: "Zahlungseingang zur Rechnung {{invoice.number}}",
      body: "Guten Tag,\n\nvielen Dank, wir haben Ihre Zahlung über {{paymentReceived.amount}} vom {{paymentReceived.date}} zur Rechnung {{invoice.number}} erhalten. Die Rechnung ist damit vollständig bezahlt.\n\nFreundliche Grüße\n{{company.name}}",
    },
    partial: {
      subject: "Zahlungseingang zur Rechnung {{invoice.number}}",
      body: "Guten Tag,\n\nvielen Dank, wir haben Ihre Zahlung über {{paymentReceived.amount}} vom {{paymentReceived.date}} zur Rechnung {{invoice.number}} erhalten. Offen sind noch {{paymentReceived.openAmount}}.\n\nFreundliche Grüße\n{{company.name}}",
    },
  },
  en: {
    full: {
      subject: "Payment received for invoice {{invoice.number}}",
      body: "Hello,\n\nthank you, we have received your payment of {{paymentReceived.amount}} dated {{paymentReceived.date}} for invoice {{invoice.number}}. The invoice is now paid in full.\n\nKind regards\n{{company.name}}",
    },
    partial: {
      subject: "Payment received for invoice {{invoice.number}}",
      body: "Hello,\n\nthank you, we have received your payment of {{paymentReceived.amount}} dated {{paymentReceived.date}} for invoice {{invoice.number}}. {{paymentReceived.openAmount}} is still outstanding.\n\nKind regards\n{{company.name}}",
    },
  },
};

const PRIOR_SELECT = { id: true, status: true } as const;

/** Vorgaenger-Protokoll der Zahlung: bereits gesendet (ALREADY), Ergebnis unbekannt (SKIPPED) oder frei. */
async function priorOutcome(orgId: string, paymentId: string, client: Pick<typeof dbInternal, "emailLog"> = dbInternal): Promise<ConfirmationOutcome | null> {
  const logs = await client.emailLog.findMany({
    where: { orgId, docType: PAYMENT_CONFIRMATION_DOC_TYPE, docId: paymentId },
    select: PRIOR_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const done = logs.find((l) => l.status !== "FAILED" && l.status !== "QUEUED");
  if (done) return { kind: "ALREADY", logId: done.id };
  if (logs.some((l) => l.status === "QUEUED")) return { kind: "SKIPPED", note: "Versandergebnis unbekannt — E-Mail-Protokoll pruefen" };
  return null;
}

async function pickTemplate(orgId: string, templateId: string | null, language: DocLanguage): Promise<{ id: string; subject: string; body: string; signature: string | null } | null> {
  const select = { id: true, subject: true, body: true, signature: true } as const;
  if (templateId) {
    const chosen = await dbInternal.emailTemplate.findFirst({ where: { id: templateId, orgId, docType: PAYMENT_CONFIRMATION_DOC_TYPE }, select });
    if (chosen) return chosen;
  }
  return dbInternal.emailTemplate.findFirst({ where: { orgId, docType: PAYMENT_CONFIRMATION_DOC_TYPE, language, isDefault: true }, select });
}

/** Fruehester Zeitpunkt, an dem das Fenster wieder Platz hat: (count - limit + 1)-aeltester Versand + 1 Stunde. */
async function windowUntil(
  tx: Pick<typeof dbInternal, "paymentRuleRun">,
  where: { orgId: string; customerId?: string },
  run: ConfirmationRun,
  since: Date,
  limit: number,
): Promise<Date | null> {
  const filter = { ...where, id: { not: run.id }, mailSentAt: { gt: since } };
  const count = await tx.paymentRuleRun.count({ where: filter });
  if (count < limit) return null;
  const rows = await tx.paymentRuleRun.findMany({ where: filter, orderBy: { mailSentAt: "asc" }, take: count - limit + 1, select: { mailSentAt: true } });
  const last = rows[rows.length - 1]?.mailSentAt;
  return new Date((last?.getTime() ?? since.getTime()) + HOUR_MS);
}

export interface BuiltConfirmation {
  to: string;
  subject: string;
  text: string;
  warnings: string[];
  templateId: string | null;
  lang: DocLanguage;
  invoiceNumber: string | null;
}

/** Baut Empfaenger, Betreff und Text der Zahlungsbestaetigung rein lesend (gemeinsam fuer Versand und Trockenlauf). */
export async function buildPaymentConfirmation(
  orgId: string,
  invoiceId: string,
  context: z.infer<typeof contextSchema>,
  paymentMethodCode: string | null,
  templateId: string | null,
): Promise<{ ok: true; built: BuiltConfirmation } | { ok: false; note: string }> {
  const invoice = await dbInternal.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { number: true, language: true } });
  if (!invoice) return { ok: false, note: "Rechnung nicht gefunden" };
  const lang = resolveDocLanguage(invoice.language);

  let built: Awaited<ReturnType<typeof buildTemplateContext>>;
  try {
    built = await buildTemplateContext(orgId, "INVOICE", invoiceId);
  } catch (e) {
    if (e instanceof DocumentNotFoundError) return { ok: false, note: "Rechnung nicht gefunden" };
    throw e;
  }
  const rawTo = built.customerEmail?.trim() ?? "";
  if (rawTo === "") return { ok: false, note: "Kunde ohne E-Mail-Adresse" };
  const parsedTo = recipientSchema.safeParse(rawTo);
  if (!parsedTo.success) return { ok: false, note: "Empfaengeradresse ungueltig" };

  const method = paymentMethodCode ? await dbInternal.paymentMethod.findFirst({ where: { orgId, code: paymentMethodCode }, select: { name: true } }) : null;
  const ctx: TemplateContext = {
    ...built.ctx,
    paymentReceived: {
      amount: formatMoneyLang(context.amountCents, context.currency, lang),
      date: formatDateLang(new Date(context.paidAt), lang),
      openAmount: formatMoneyLang(context.openAfterCents, context.currency, lang),
      method: method?.name ?? paymentMethodCode ?? "",
    },
  };

  const tpl = await pickTemplate(orgId, templateId, lang);
  const fallback = BUILT_IN[lang][context.openAfterCents <= 0 ? "full" : "partial"];
  const src = tpl ?? fallback;
  const subjectR = renderTemplate(src.subject, ctx);
  const bodyR = renderTemplate(src.body, ctx);
  const sigR = renderTemplate(tpl?.signature ?? "", ctx);
  const subject = subjectR.text.replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX);
  const text = sigR.text.trim() ? `${bodyR.text}\n\n${sigR.text}` : bodyR.text;
  const warnings = [...subjectR.warnings, ...bodyR.warnings, ...sigR.warnings].slice(0, 50).map((w) => w.slice(0, 300));
  return { ok: true, built: { to: parsedTo.data, subject, text, warnings, templateId: tpl?.id ?? null, lang, invoiceNumber: invoice.number ?? context.invoiceNumber } };
}

export async function sendPaymentConfirmation(
  run: ConfirmationRun,
  action: { templateId: string | null },
  opts: { now: Date; provider?: MailProvider },
): Promise<ConfirmationOutcome> {
  const { now } = opts;
  const early = await priorOutcome(run.orgId, run.paymentId);
  if (early) return early;

  const settings = await loadMailSettings(run.orgId);
  if (!settings) return { kind: "FAILED", error: "Keine Mail-Einstellungen hinterlegt.", retryable: true, notSent: true };

  const context = contextSchema.parse(JSON.parse(run.contextJson));
  const payment = await dbInternal.payment.findFirst({ where: { id: run.paymentId, invoice: { orgId: run.orgId } }, select: { method: true } });
  const result = await buildPaymentConfirmation(run.orgId, run.invoiceId, context, payment?.method ?? null, action.templateId);
  if (!result.ok) return { kind: "SKIPPED", note: result.note };
  const { to, subject, text, warnings, lang, invoiceNumber } = result.built;
  const tpl = { id: result.built.templateId };

  // Limits und Protokoll-Anlage gemeinsam unter der Kundensperre: parallele Laeufe ueberschreiten die Grenze nicht.
  const claimed = await dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "Customer", run.customerId, run.orgId);
    const again = await priorOutcome(run.orgId, run.paymentId, tx);
    if (again) return { type: "out", outcome: again } as const;
    const since = new Date(now.getTime() - HOUR_MS);
    const untilCustomer = await windowUntil(tx, { orgId: run.orgId, customerId: run.customerId }, run, since, CONFIRMATION_MAX_PER_CUSTOMER_HOUR);
    const untilOrg = await windowUntil(tx, { orgId: run.orgId }, run, since, CONFIRMATION_MAX_PER_ORG_HOUR);
    if (untilCustomer || untilOrg) {
      const until = new Date(Math.max(untilCustomer?.getTime() ?? 0, untilOrg?.getTime() ?? 0));
      const outcome: ConfirmationOutcome = {
        kind: "DEFER", until, note: untilCustomer ? "Versandgrenze je Kunde erreicht" : "Versandgrenze je Firma erreicht",
      };
      return { type: "out", outcome } as const;
    }
    const log = await createQueuedEmailLog(
      {
        orgId: run.orgId, docType: PAYMENT_CONFIRMATION_DOC_TYPE, docId: run.paymentId, templateId: tpl?.id ?? null,
        fromEmail: settings.fromEmail, replyTo: settings.replyTo ?? null, to: [to], cc: [], bcc: [], subject, bodySnapshot: text,
        attachmentsJson: "[]", warningsJson: JSON.stringify(warnings), sentByUserId: `payment-rule:${run.ruleId}`,
      },
      tx,
    );
    return { type: "log", logId: log.id } as const;
  });
  if (claimed.type === "out") return claimed.outcome;

  // Ab hier kann die Mail den Anbieter erreicht haben: jeder Fehler gilt als "Versand unklar" (kein Auto-Retry).
  try {
    let status: "SENT" | "FAILED" = "SENT";
    let providerId: string | null = null;
    let error: string | null = null;
    let htmlSha256: string | undefined;
    let reachedSend = false;
    try {
      const provider = opts.provider ?? createSmtpProvider(settings);
      const mail = await withHtmlPart(
        run.orgId, settings,
        { from: { name: settings.fromName, address: settings.fromEmail }, to: [to], cc: [], bcc: [], replyTo: settings.replyTo ?? undefined, subject, text, attachments: [] },
        { lang },
      );
      if (mail.html !== undefined) htmlSha256 = createHash("sha256").update(mail.html).digest("hex");
      reachedSend = true;
      providerId = (await provider.send(mail)).providerId;
    } catch (e) {
      status = "FAILED";
      error = (e instanceof Error ? e.message : "Unbekannter Fehler").slice(0, 500);
    }

    const actor = `payment-rule:${run.ruleId}`;
    await withChangeLogRetry(() =>
      finishEmailLog({
        orgId: run.orgId, logId: claimed.logId, status, providerId, error, actor, docType: PAYMENT_CONFIRMATION_DOC_TYPE, docId: run.paymentId,
        docNumber: invoiceNumber, to: [to], cc: [], bcc: [], subject, attachmentsMeta: [], at: now, ...(htmlSha256 ? { htmlSha256 } : {}),
      }),
    );
    if (status === "FAILED") return { kind: "FAILED", error: reachedSend ? SEND_UNCLEAR_NOTE : (error ?? "Versand fehlgeschlagen"), retryable: !reachedSend, notSent: !reachedSend };
    await logActivity(dbInternal, {
      orgId: run.orgId, entityType: "INVOICE", entityId: run.invoiceId, type: "PAYMENT_CONFIRMATION_SENT", actor, at: now,
      data: { paymentId: run.paymentId, logId: claimed.logId, subject: maskPortalLinks(subject), to: [to] },
    });
  } catch (e) {
    console.error("Zahlungsbestaetigung: Verbuchung nach dem Versandversuch fehlgeschlagen", describeError(e));
    return { kind: "FAILED", error: SEND_UNCLEAR_NOTE, retryable: false, notSent: false };
  }
  return { kind: "SENT", logId: claimed.logId };
}
