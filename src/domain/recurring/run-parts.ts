/**
 * Gemeinsame Bausteine des Abo-Laufs (Einzel- und Sammelrechnung): Positionen samt Verbrauch,
 * Fortschreiben des Abos, Eingabe fuer den Rechnungspfad und Auto-Versand.
 */
import type { Prisma } from "@/generated/prisma/client";
import { berlinCalendarDay } from "@/lib/berlin-time";
import { advanceDate, periodRange, type RecurInterval } from "@/lib/recurring";
import { formatDateDe } from "@/lib/template/format";
import { resolveDocLanguage } from "@/lib/i18n/doc";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { finalizeWithinTx } from "@/domain/invoice/finalize";
import { linkDocuments } from "@/domain/relations";
import { prefillEmail } from "@/domain/email/compose";
import { sendDocumentEmail } from "@/domain/email/send";
import type { MailProvider } from "@/lib/mail/provider";
import type { CreateInvoiceInput } from "@/schemas";
import { MAX_USAGE_QUANTITY_MILLI } from "@/schemas/recurring-usage";
import { RecurringError } from "./errors";
import { itemTaxRates, recurringLinesToInvoiceLines } from "./lines";
import { collectBillableUsage, markUsageBilled } from "./usage";
import type { EmitOutcome, EmittedInvoice } from "./run-types";
import { effectiveAnchorDay } from "./usage-period";

export const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Festpositionen ohne eigenen Leistungszeitraum bekommen den Abrechnungszeitraum (BG-26). */
export function applyFixedServicePeriod(
  lines: CreateInvoiceInput["lines"],
  period: { start: Date; end: Date },
): CreateInvoiceInput["lines"] {
  return lines.map((l) =>
    l.lineType === "ITEM" && !l.servicePeriodStart && !l.servicePeriodEnd
      ? { ...l, servicePeriodStart: period.start, servicePeriodEnd: period.end }
      : l,
  );
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
  opts: { fixedServicePeriod: boolean },
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
  const period = periodRange(periodDate, rec.interval as RecurInterval, rec.intervalCount, anchorDay);
  const base = recurringLinesToInvoiceLines(rec.lines, usage);
  return {
    lines: opts.fixedServicePeriod ? applyFixedServicePeriod(base, period) : base,
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
  const next = advanceDate(periodDate, rec.interval as RecurInterval, rec.intervalCount, anchorDay);
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
  const next = advanceDate(periodDate, rec.interval as RecurInterval, rec.intervalCount, anchorDay);
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
  periodDate: Date,
  now: Date,
): CreateInvoiceInput {
  let headerText: string | undefined;
  let deliveryStart: Date | undefined;
  let deliveryEnd: Date | undefined;
  // showPeriodText ist allein massgeblich; ist es aus, greift die Kopftextvorlage des Rechnungspfads.
  if (rec.showPeriodText) {
    headerText = `Abrechnungszeitraum ${formatDateDe(built.period.start)} – ${formatDateDe(periodDate)}`;
    deliveryStart = built.period.start;
    deliveryEnd = periodDate;
  }
  return {
    customerId: rec.customerId,
    language: resolveDocLanguage(rec.language),
    type: "INVOICE",
    taxScheme: rec.taxScheme as CreateInvoiceInput["taxScheme"],
    currency: rec.currency,
    issueDate: now,
    deliveryDate: periodDate,
    deliveryStart,
    deliveryEnd,
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
  const input = buildSingleInvoiceInput(rec, built, periodDate, now);
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
  const result: EmittedInvoice = {
    invoiceId: invoice.id,
    number,
    periodDate,
    finalized,
    ...(adv.notice ? { notice: adv.notice } : {}),
  };
  return { result, ended: adv.ended, autoSend: rec.autoSend, orgId: rec.orgId, emailTemplateId: rec.emailTemplateId };
}

/**
 * Versendet die erzeugte Rechnung ueber die Standardvorlage INVOICE — LAEUFT AUSSERHALB jeder
 * Prisma-Transaktion. Ohne Kunden-E-Mail oder Mailkonfiguration: SKIPPED statt eines geworfenen
 * Fehlers, der Lauf der uebrigen Abos darf nicht abbrechen.
 */
export async function sendRecurringInvoiceEmail(
  orgId: string,
  invoiceId: string,
  provider: MailProvider | undefined,
  emailTemplateId: string | null,
): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; error?: string }> {
  try {
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId, templateId: emailTemplateId ?? undefined });
    if (pre.to.length === 0) return { status: "SKIPPED" };
    const result = await sendDocumentEmail(
      orgId,
      "recurring-runner",
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
    return result.status === "SENT" ? { status: "SENT" } : { status: "FAILED", error: result.error };
  } catch (e) {
    return { status: "FAILED", error: e instanceof Error ? e.message : String(e) };
  }
}
