/**
 * Gemeinsame Bausteine des Abo-Laufs (Einzel- und Sammelrechnung): Positionen samt Verbrauch,
 * Fortschreiben des Abos, Eingabe fuer den Rechnungspfad und Auto-Versand.
 */
import { AUTO_SEND_ACTOR } from "./auto-send-guard";
import type { Prisma } from "@/generated/prisma/client";
import { berlinCalendarDay } from "@/lib/berlin-time";
import { billingPeriod, nextStichtag, type BillingTiming, type RecurInterval } from "@/lib/recurring";
import { docStrings, formatDocDate, resolveDocLanguage } from "@/lib/i18n/doc";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { finalizeWithinTx } from "@/domain/invoice/finalize";
import { linkDocuments } from "@/domain/relations";
import { prefillEmail } from "@/domain/email/compose";
import { sendDocumentEmail } from "@/domain/email/send";
import { MailNotConfiguredError } from "@/domain/email/settings";
import type { MailProvider } from "@/lib/mail/provider";
import type { CreateInvoiceInput } from "@/schemas";
import { MAX_USAGE_QUANTITY_MILLI } from "@/schemas/recurring-usage";
import { RecurringError } from "./errors";
import { itemTaxRates, recurringLinesToInvoiceLines } from "./lines";
import { collectBillableUsage, markUsageBilled } from "./usage";
import type { EmitOutcome, EmittedInvoice } from "./run-types";
import { enqueueAutoSendWithinTx } from "./auto-send";
import { effectiveAnchorDay } from "./usage-period";
import { findLastBilled } from "./last-billed";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Akteur der Mail-Protokolle des automatischen Versands (Abgrenzung zum manuellen Versand). */
export { AUTO_SEND_ACTOR };

export type RecWithLines = Prisma.RecurringInvoiceGetPayload<{ include: { lines: true } }>;

/**
 * Faelligkeit eines Abo-Laufs. Abos MIT Verbrauchsposition werden erst am Berliner Kalendertag
 * NACH dem Stichtag faellig (der Stichtag gehoert vollstaendig zur endenden Periode);
 * alle anderen Abos wie bisher ab `nextRunDate <= now`.
 */
export function isRunDue(nextRunDate: Date, now: Date, hasUsageLines: boolean): boolean {
  if (!hasUsageLines) return nextRunDate.getTime() <= now.getTime();
  return berlinCalendarDay(now).getTime() > berlinCalendarDay(nextRunDate).getTime();
}

export interface RunLines {
  lines: CreateInvoiceInput["lines"];
  usageIds: string[];
  usageCount: number;
  usageQuantityMilli: number;
  hasUsageLines: boolean;
  hasItems: boolean;
  anchorDay: number | null;
  period: { start: Date; end: Date };
}

/**
 * Positionen 1:1 aus dem Abo (inkl. Ueberschriften/Texte/Zwischensummen, Langtext, Artikelnummer,
 * Festbetragsrabatt, Produktbezug). USAGE-Zeilen tragen die Summe der offenen Verbraeuche bis zum
 * Stichtag. Der Aufrufer haelt die Abo-Sperre. Netto-/Steuerberechnung uebernimmt der Rechnungspfad.
 */
export async function buildRunLines(
  tx: Prisma.TransactionClient,
  rec: RecWithLines,
  periodDate: Date,
): Promise<RunLines> {
  const hasUsageLines = rec.lines.some((l) => l.billing === "USAGE");
  const usage = await collectBillableUsage(tx, rec.id, periodDate);
  let usageCount = 0;
  let usageQuantityMilli = 0;
  for (const u of usage.values()) {
    if (u.quantityMilli > MAX_USAGE_QUANTITY_MILLI) throw new RecurringError("Verbrauchsmenge zu groß.");
    usageCount += u.ids.length;
    usageQuantityMilli += u.quantityMilli;
  }
  const anchorDay = effectiveAnchorDay(rec, hasUsageLines);
  // Leistungszeitraum (inklusive Grenzen) dieses Laufs: an Kopf (BG-14) und jeder ITEM-Zeile (BG-26).
  // Bestandsabos ohne Ankertag: Beginn hinter das Ende der letzten Abrechnung (keine Doppelung nach dem Klemmen).
  const previous = rec.billingTiming === "ARREARS" && anchorDay === null ? await findLastBilled(tx, rec.orgId, rec.id) : null;
  const { start, end } = billingPeriod(
    rec.billingTiming as BillingTiming,
    periodDate,
    rec.interval as RecurInterval,
    rec.intervalCount,
    anchorDay,
    rec.endDate,
    previous?.period?.end ?? previous?.deliveryDate ?? null,
  );
  const period = { start, end };
  const base = recurringLinesToInvoiceLines(rec.lines, usage, period);
  return {
    lines: base,
    usageIds: [...usage.values()].flatMap((u) => u.ids),
    usageCount,
    usageQuantityMilli,
    hasUsageLines,
    hasItems: base.some((l) => l.lineType === "ITEM"),
    anchorDay,
    period,
  };
}

/** Periode ohne Verbrauch: Abo rueckt weiter, ohne eine Rechnung zu zaehlen. */
export async function advanceEmptyPeriod(
  tx: Prisma.TransactionClient,
  rec: RecWithLines,
  periodDate: Date,
  anchorDay: number | null,
): Promise<{ ended: boolean }> {
  const next = nextStichtag(periodDate, rec.interval as RecurInterval, rec.intervalCount, anchorDay);
  const ended = rec.endDate ? next > rec.endDate : false;
  await tx.recurringInvoice.update({
    where: { id: rec.id },
    data: { nextRunDate: next, status: ended ? "ENDED" : "ACTIVE" },
  });
  return { ended };
}

/** Schreibt das Abo nach einer erzeugten Rechnung fort (Stichtag, Zaehler, Ende durch Datum/maxRuns). */
export async function advanceAfterEmit(
  tx: Prisma.TransactionClient,
  rec: RecWithLines,
  periodDate: Date,
  now: Date,
  anchorDay: number | null,
): Promise<{ ended: boolean; notice?: string }> {
  const next = nextStichtag(periodDate, rec.interval as RecurInterval, rec.intervalCount, anchorDay);
  // issuedCount VOR dem Erhoehen ist die Anzahl der bereits vorherigen Laeufe.
  const issuedCountAfter = rec.issuedCount + 1;
  const endedByDate = rec.endDate ? next > rec.endDate : false;
  const reachedMaxRuns = rec.maxRuns != null && issuedCountAfter >= rec.maxRuns;
  // Verbrauch nach dem Ende der letzten Periode darf nicht still offen bleiben: das Abo bleibt dann aktiv
  // und rechnet ihn im naechsten Lauf ab (auch ueber maxRuns hinaus).
  const openAfterEnd = reachedMaxRuns && !endedByDate
    ? await tx.recurringUsage.count({
        where: { recurringInvoiceId: rec.id, orgId: rec.orgId, invoiceId: null, voidedAt: null, recurringLineId: { not: null }, periodEnd: { gt: periodDate } },
      })
    : 0;
  const ended = endedByDate || (reachedMaxRuns && openAfterEnd === 0);
  await tx.recurringInvoice.update({
    where: { id: rec.id },
    data: {
      nextRunDate: next,
      lastRunAt: now,
      issuedCount: { increment: 1 },
      status: ended ? "ENDED" : "ACTIVE",
    },
  });
  return {
    ended,
    ...(openAfterEnd > 0 ? { notice: `Abo bleibt aktiv: maxRuns erreicht, aber ${openAfterEnd} offene Verbrauchserfassung(en) nach dem Periodenende.` } : {}),
  };
}

/**
 * Eingabe fuer eine Einzelrechnung aus genau einem Abo. Felder, die das Abo selbst fuehrt
 * (taxScheme, currency, notes, Positionen, Faelligkeit), gewinnen; alles andere zieht der
 * Rechnungspfad aus den Kundenvorgaben.
 */
export function buildSingleInvoiceInput(
  rec: RecWithLines,
  built: RunLines,
  now: Date,
): CreateInvoiceInput {
  const language = resolveDocLanguage(rec.language);
  // Kopftext nur, wenn gewuenscht; BG-14/BG-26 (und damit der Zeitraum auf dem Beleg) gelten immer.
  const headerText = rec.showPeriodText
    ? docStrings(language).recurring.periodHeader(formatDocDate(built.period.start, language), formatDocDate(built.period.end, language))
    : undefined;
  return {
    customerId: rec.customerId,
    language,
    type: "INVOICE",
    taxScheme: rec.taxScheme as CreateInvoiceInput["taxScheme"],
    currency: rec.currency,
    issueDate: now,
    // Kein Einzel-Leistungsdatum (BT-72): der Leistungszeitraum steht in BG-14.
    deliveryStart: built.period.start,
    deliveryEnd: built.period.end,
    // dueDate explizit aus der Abo-Zusage, sonst wuerde die Kundenvorgabe sie ueberstimmen.
    dueDate: new Date(now.getTime() + rec.paymentTermsDays * DAY_MS),
    notes: rec.notes ?? undefined,
    headerText,
    documentChargePermille: 0,
    documentChargeCents: 0,
    lines: built.lines,
  };
}

export interface EmitTxResult {
  result: EmitOutcome;
  ended: boolean;
  autoSend: boolean;
  orgId: string;
  emailTemplateId: string | null;
}

/** Einzelrechnung aus genau einem Abo innerhalb der Transaktion (Abo-Sperre haelt der Aufrufer). */
export async function emitSingleInvoice(
  tx: Prisma.TransactionClient,
  rec: RecWithLines,
  built: RunLines,
  periodDate: Date,
  now: Date,
  actor: string,
): Promise<EmitTxResult> {
  const input = buildSingleInvoiceInput(rec, built, now);
  const invoice = await createDraftInvoiceWithinTx(tx, rec.orgId, input, {
    actor,
    now,
    // Der/die im Abo verwendete(n) Steuersatz/-saetze gilt/gelten zusaetzlich als erlaubt, auch wenn er/sie
    // inzwischen aus der Org-Liste entfernt wurde(n) — kein Bypass, sonst scheiterte ein Bestandsabo.
    inheritedTaxRates: itemTaxRates(rec.lines),
    recurringInvoiceId: rec.id,
    // Abo-Kontext im selben ChangeLog-CREATE- und ActivityLog-CREATED-Eintrag wie der gemeinsame Pfad.
    changeLogExtra: {
      recurring: rec.id,
      period: periodDate.toISOString(),
      ...(built.usageCount > 0 ? { usageCount: built.usageCount, usageQuantityMilli: built.usageQuantityMilli } : {}),
    },
  });

  // Doppelabrechnung ausgeschlossen: Abo-Sperre + bedingtes updateMany mit Zaehlerpruefung (Fehler -> Rollback).
  await markUsageBilled(tx, built.usageIds, invoice.id, now);
  await linkDocuments(tx, { orgId: rec.orgId, fromType: "INVOICE", fromId: invoice.id, toType: "RECURRING", toId: rec.id, relationType: "GENERATED_BY" });

  let number: string | null = invoice.number;
  let finalized = false;
  if (rec.autoFinalize) {
    const fin = await finalizeWithinTx(tx, invoice.id, { now, actor });
    number = fin.number;
    finalized = true;
  }
  const adv = await advanceAfterEmit(tx, rec, periodDate, now, built.anchorDay);
  // Outbox des automatischen Versands in DERSELBEN Transaktion: Rechnung und Versandauftrag entstehen gemeinsam oder gar nicht.
  if (rec.autoSend && finalized) {
    await enqueueAutoSendWithinTx(tx, { orgId: rec.orgId, invoiceId: invoice.id, recurringId: rec.id, now });
  }
  const result: EmittedInvoice = {
    invoiceId: invoice.id,
    number,
    periodDate,
    finalized,
    ...(adv.notice ? { notice: adv.notice } : {}),
  };
  return { result, ended: adv.ended, autoSend: rec.autoSend, orgId: rec.orgId, emailTemplateId: rec.emailTemplateId };
}

/** Ergebnis EINES Versandversuchs (interner Baustein von auto-send.ts). */
export type RecurringMailAttempt =
  | { status: "SENT"; logId: string }
  /** Kein Empfaenger ermittelt (Kunde ohne E-Mail). */
  | { status: "SKIPPED" }
  /** Das Protokoll existiert und sagt FAILED; `outcome` trennt "sicher nicht angenommen" von "unklar". */
  | { status: "FAILED"; outcome: "NOT_SENT" | "UNKNOWN"; error?: string }
  /** Eine Ausnahme beim Vorbereiten/Versenden. `mailNotConfigured`: Mailzugang fehlt. Ob schon ein Protokoll entstand, prueft der Aufrufer. */
  | { status: "THROWN"; mailNotConfigured: boolean };

/**
 * Ein Versandversuch der erzeugten Rechnung ueber die Standardvorlage INVOICE — LAEUFT AUSSERHALB jeder
 * Prisma-Transaktion. NUR von `auto-send.ts` aufzurufen (kein zweiter Versandweg): dort entscheiden
 * Claim, Wiederholung und Doppelversand-Schutz.
 */
export async function sendRecurringInvoiceEmail(
  orgId: string,
  invoiceId: string,
  provider: MailProvider | undefined,
  emailTemplateId: string | null,
): Promise<RecurringMailAttempt> {
  let pre: Awaited<ReturnType<typeof prefillEmail>>;
  try {
    pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId, templateId: emailTemplateId ?? undefined });
  } catch (e) {
    return { status: "THROWN", mailNotConfigured: e instanceof MailNotConfiguredError };
  }
  if (pre.to.length === 0) return { status: "SKIPPED" };
  try {
    const result = await sendDocumentEmail(
      orgId,
      AUTO_SEND_ACTOR,
      {
        docType: "INVOICE",
        docId: invoiceId,
        to: pre.to.join(","),
        cc: pre.cc.join(","),
        bcc: pre.bcc.join(","),
        subject: pre.subject,
        body: pre.body,
        signature: pre.signature,
        copyToSelf: pre.copyToSelf,
        standardAttachments: pre.defaultStandardAttachments,
        templateId: pre.templateId,
        warnings: pre.warnings,
      },
      [],
      provider,
    );
    return result.status === "SENT"
      ? { status: "SENT", logId: result.logId }
      : { status: "FAILED", outcome: result.outcome ?? "UNKNOWN", error: result.error };
  } catch (e) {
    return { status: "THROWN", mailNotConfigured: e instanceof MailNotConfiguredError };
  }
}
