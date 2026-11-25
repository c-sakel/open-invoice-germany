/**
 * Legt ein Abo / eine wiederkehrende Rechnung an. Die Vorlage selbst ist KEIN
 * Beleg (frei editierbar, kein Hash-Chain-Eintrag) — erst die daraus erzeugten
 * Rechnungen sind GoBD-relevant. `nextRunDate` ist der erste Stichtag (im Voraus = Startdatum).
 */
import { resolveLineOssCategories } from "@/domain/product/oss-snapshot";
import { dbInternal } from "@/lib/db";
import { toRecurringLineRows } from "@/domain/recurring/lines";
import { normalizeToNoon, type BillingTiming } from "@/lib/recurring";
import { assertTimingFitsLines, resolveFirstSchedule } from "@/domain/recurring/timing";
import { loadDocumentSettings } from "@/domain/document/settings";
import { resolveDocLanguage } from "@/lib/i18n/doc";
import { assertAllowedTaxRates, ratesOfLines } from "@/domain/settings/tax-rates";
import type { CreateRecurringInput } from "@/schemas";
import { RecurringError } from "@/domain/recurring/errors";

export { RecurringError };

export async function createRecurring(orgId: string, input: CreateRecurringInput) {
  const customer = await dbInternal.customer.findFirst({ where: { id: input.customerId, orgId }, select: { id: true, defaultCurrency: true, language: true, isArchived: true } });
  if (!customer) throw new RecurringError("Kunde nicht gefunden.");
  if (customer.isArchived) throw new RecurringError("Archivierte Kunden koennen keinem neuen Abo zugeordnet werden.");
  if (input.collectiveBilling === true && (input.invoiceHeading === undefined || input.invoiceHeading.trim() === "")) {
    throw new RecurringError("Blockueberschrift ist fuer Sammelrechnungen Pflicht.");
  }
  if (input.endDate && input.endDate < input.startDate) throw new RecurringError("Enddatum liegt vor dem Startdatum.");

  // Stichtage auf 12:00 lokal ankern (DST-/Zeitzonen-sichere Tagesanzeige).
  const startDate = normalizeToNoon(input.startDate);
  const endDate = input.endDate ? normalizeToNoon(input.endDate) : null;

  // Abrechnungsart (R1): ohne Angabe im Voraus, bei Verbrauchspositionen nachträglich.
  const hasUsageLines = input.lines.some((l) => l.billing === "USAGE");
  const timing: BillingTiming = input.billingTiming ?? (hasUsageLines ? "ARREARS" : "ADVANCE");
  assertTimingFitsLines(timing, hasUsageLines);
  // Leistungsbeginn prüfen, dann ersten Stichtag + Ankertag ableiten (R7/R8).
  const first = resolveFirstSchedule(timing, startDate, input.interval, input.intervalCount, input.anchorDay);

  // recurringAutoFinalizeDefault/recurringAutoSendDefault (Phase 7, §33): greifen nur,
  // wenn der Aufrufer die Felder nicht selbst gesetzt hat.
  const docSettings = await loadDocumentSettings(orgId);
  const autoSend = input.autoSend ?? docSettings.recurringAutoSendDefault;
  // S4 (Fix-Welle, Final-Review): autoSend ohne autoFinalize versendete bisher eine
  // Rechnung mit Nummer "ENTWURF" und GiroCode-Verwendungszweck "ENTWURF" an den Kunden.
  // Versand setzt Festschreibung voraus — autoSend erzwingt autoFinalize.
  const autoFinalize = autoSend ? true : (input.autoFinalize ?? docSettings.recurringAutoFinalizeDefault);
  // showPeriodText (Phase 8b, §43): ohne explizite Angabe uebernimmt das Abo den
  // Settings-Default (recurringInsertPeriodText) zum Anlagezeitpunkt — spaetere
  // Aenderungen der Org-Einstellung wirken danach NICHT mehr rueckwirkend auf dieses
  // Abo (Task-1-Facts: "je Abo ueberstimmt den Settings-Default").
  const showPeriodText = input.showPeriodText ?? docSettings.recurringInsertPeriodText;

  await assertAllowedTaxRates(dbInternal, orgId, ratesOfLines(input.lines));

  // Phase 16e: OSS-Kategorie-Snapshot (explizit > Produkt der Org > null) fuer den Abo-Lauf.
  const ossCategories = await resolveLineOssCategories(dbInternal, orgId, input.lines);
  const lines = toRecurringLineRows(input.lines, ossCategories);

  return dbInternal.recurringInvoice.create({
    data: {
      orgId,
      customerId: input.customerId,
      language: input.language ?? resolveDocLanguage(customer.language),
      title: input.title,
      status: "ACTIVE",
      interval: input.interval,
      intervalCount: input.intervalCount,
      anchorDay: first.anchorDay,
      billingTiming: timing,
      startDate,
      nextRunDate: first.stichtag,
      endDate,
      maxRuns: input.maxRuns ?? null,
      taxScheme: input.taxScheme,
      // Kette wie Rechnung/Beleg: Eingabe > Kundenvorgabe > DocumentSettings.defaultCurrency > EUR.
      currency: input.currency ?? customer.defaultCurrency ?? docSettings.defaultCurrency ?? "EUR",
      paymentTermsDays: input.paymentTermsDays,
      autoFinalize,
      autoSend,
      emailTemplateId: input.emailTemplateId ?? null,
      showPeriodText,
      notes: input.notes ?? null,
      collectiveBilling: input.collectiveBilling ?? false,
      invoiceHeading: input.invoiceHeading ?? null,
      lines: { create: lines },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
}
