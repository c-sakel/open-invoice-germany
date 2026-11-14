/**
 * Aendert ein bestehendes Abo (Phase 8b, Task 4, §43) — Task 1/2 kannten nur
 * `createRecurring` (Anlage) und `updateRecurringStatusSchema` (reiner Statuswechsel).
 * Teil-Update: nur uebergebene Felder werden geaendert. Die Vorlage selbst ist KEIN
 * GoBD-Beleg (kein Hash-Chain-Eintrag noetig) — nur die daraus erzeugten Rechnungen sind
 * festgeschrieben und bleiben von dieser Aenderung unberuehrt.
 */
import { resolveLineOssCategories } from "@/domain/product/oss-snapshot";
import { dbInternal } from "@/lib/db";
import { itemTaxRates, planLineSync, toRecurringLineRows } from "@/domain/recurring/lines";
import { lockRow } from "@/lib/db-lock";
import { normalizeToNoon } from "@/lib/recurring";
import { updateRecurringSchema, resolveLineCategories, type TaxScheme as TaxSchemeValue, type UpdateRecurringInput } from "@/schemas";
import { NotFoundError, InvalidOperationError } from "@/domain/errors";
import { RecurringError } from "@/domain/recurring/create";
import { logActivity } from "@/domain/activity/log";
import { assertAllowedTaxRates, ratesOfLines } from "@/domain/settings/tax-rates";

export async function updateRecurringInvoice(orgId: string, id: string, raw: unknown, actor = "system") {
  const input: UpdateRecurringInput = updateRecurringSchema.parse(raw);

  return dbInternal.$transaction(async (tx) => {
    // Phase 16e: OSS-Kategorie-Snapshot (explizit > Produkt der Org > null) fuer den Abo-Lauf.
    // Phase 18f: Sperre vor dem Lesen der Zeilen/Verbraeuche (serialisiert gegen Erfassung und Lauf).
    await lockRow(tx, "RecurringInvoice", id, orgId);
    const existing = await tx.recurringInvoice.findFirst({
      where: { id, orgId },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        issuedCount: true,
        status: true,
        interval: true,
        intervalCount: true,
        anchorDay: true,
        nextRunDate: true,
        maxRuns: true,
        taxScheme: true,
        lines: { select: { taxRate: true, lineType: true } },
      },
    });
    if (!existing) throw new NotFoundError("Abo nicht gefunden.");

    // Fix-Welle (Nit): ein aus ENDED reaktiviertes Abo (status -> ACTIVE) behaelt sein
    // bisheriges maxRuns unveraendert bei — war das Abo bereits ENDED, WEIL issuedCount
    // >= maxRuns erreicht war (siehe recurring/run.ts), wuerde die Reaktivierung ohne
    // gleichzeitige maxRuns-Erhoehung den naechsten Lauf sofort wieder auf ENDED setzen
    // (stiller Zyklus statt eines Fehlers). Effektives maxRuns = neuer Wert (falls in
    // diesem Aufruf mitgegeben) sonst der bestehende.
    const effectiveMaxRuns = input.maxRuns !== undefined ? input.maxRuns : existing.maxRuns;
    if (input.status === "ACTIVE" && existing.status === "ENDED" && effectiveMaxRuns != null && existing.issuedCount >= effectiveMaxRuns) {
      throw new InvalidOperationError(
        `Abo kann nicht reaktiviert werden: issuedCount (${existing.issuedCount}) hat maxRuns (${effectiveMaxRuns}) bereits erreicht. Zuerst maxRuns erhoehen oder entfernen.`,
      );
    }

    // Fix-Runde 1 (Koordinator, Abo-Bearbeiten-UI): startDate ist nachtraeglich aenderbar.
    const startDate = input.startDate === undefined ? undefined : normalizeToNoon(input.startDate);
    const effectiveStartDate = startDate ?? existing.startDate;

    const endDate = input.endDate === undefined ? undefined : input.endDate ? normalizeToNoon(input.endDate) : null;
    const effectiveEndDate = endDate === undefined ? existing.endDate : endDate;
    if (effectiveEndDate && effectiveEndDate < effectiveStartDate) {
      throw new RecurringError("Enddatum liegt vor dem Startdatum.");
    }

    // nextRunDate NUR mitziehen, wenn noch keine Rechnung erzeugt wurde (issuedCount===0) —
    // sonst wuerde eine nachtraegliche startDate-Korrektur den bereits fortgeschrittenen
    // Erzeugungsplan eines laufenden Abos zurueckspulen (Ruling: reine Metadatenkorrektur
    // fuer bereits aktive Abos, volle Schedule-Uebernahme nur vor dem ersten Lauf, analog
    // createRecurring()).
    const nextRunDate = startDate !== undefined && existing.issuedCount === 0 ? startDate : undefined;

    // Phase 18f: Perioden offener Verbraeuche haengen an Stichtag/Intervall/Anker — Aenderung waere veraltet.
    const scheduleChanged =
      (input.interval !== undefined && input.interval !== existing.interval) ||
      (input.intervalCount !== undefined && input.intervalCount !== existing.intervalCount) ||
      (input.anchorDay !== undefined && input.anchorDay !== existing.anchorDay) ||
      (nextRunDate !== undefined && nextRunDate.getTime() !== existing.nextRunDate.getTime());
    if (scheduleChanged) {
      const openUsage = await tx.recurringUsage.count({ where: { recurringInvoiceId: id, orgId, invoiceId: null, voidedAt: null } });
      if (openUsage > 0) {
        throw new RecurringError("Stichtag, Intervall oder Ankertag können nicht geändert werden, solange offene Verbräuche existieren. Verbräuche zuerst abrechnen oder stornieren.");
      }
    }
    const ossCategories = input.lines ? await resolveLineOssCategories(tx, orgId, input.lines) : [];
    let lineRows: ReturnType<typeof toRecurringLineRows> = [];
    let sync: ReturnType<typeof planLineSync> | null = null;
    if (input.lines) {
      await assertAllowedTaxRates(tx, orgId, ratesOfLines(input.lines), { existing: itemTaxRates(existing.lines) });
      // Phase 18f: Zeilen behalten ihre Id (Verbrauchssaetze verweisen darauf) — Abgleich statt deleteMany.
      const stored = await tx.recurringInvoiceLine.findMany({ where: { recurringInvoiceId: id }, select: { id: true, billing: true } });
      // Fehlt `billing` bei vorhandener Zeilen-Id, gilt der bisherige Wert (nicht still FIXED).
      const storedBilling = new Map(stored.map((l) => [l.id, l.billing]));
      const inputLines = input.lines.map((l) => {
        const prev = l.id !== undefined ? storedBilling.get(l.id) : undefined;
        if (l.billing !== undefined || prev === undefined) return l;
        // Verbrauchszeile bleibt Verbrauchszeile; ihre Menge ergibt sich aus den Verbraeuchen (immer 0 gespeichert).
        return prev === "USAGE" ? { ...l, billing: "USAGE" as const, quantityMilli: 0 } : { ...l, billing: "FIXED" as const };
      });
      lineRows = toRecurringLineRows(resolveLineCategories(inputLines, existing.taxScheme as TaxSchemeValue), ossCategories);
      const open = await tx.recurringUsage.groupBy({
        by: ["recurringLineId"],
        where: { recurringInvoiceId: id, invoiceId: null, voidedAt: null, recurringLineId: { not: null } },
        _count: { _all: true },
      });
      const openByLine = new Map(open.flatMap((g) => (g.recurringLineId ? [[g.recurringLineId, g._count._all] as const] : [])));
      sync = planLineSync(
        stored.map((l) => ({ id: l.id, billing: l.billing, openUsage: openByLine.get(l.id) ?? 0 })),
        inputLines.map((l) => ({ id: l.id, billing: l.billing })),
      );
      if (sync.delete.length > 0) await tx.recurringInvoiceLine.deleteMany({ where: { recurringInvoiceId: id, id: { in: sync.delete } } });
      for (const [index, row] of lineRows.entries()) {
        const lineId = input.lines[index]?.id;
        if (lineId !== undefined) await tx.recurringInvoiceLine.update({ where: { id: lineId }, data: row });
      }
    }

    return tx.recurringInvoice.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.interval !== undefined ? { interval: input.interval } : {}),
        ...(input.intervalCount !== undefined ? { intervalCount: input.intervalCount } : {}),
        ...(input.anchorDay !== undefined ? { anchorDay: input.anchorDay } : {}),
        ...(startDate !== undefined ? { startDate } : {}),
        ...(nextRunDate !== undefined ? { nextRunDate } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
        ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
        ...(input.paymentTermsDays !== undefined ? { paymentTermsDays: input.paymentTermsDays } : {}),
        ...(input.autoFinalize !== undefined ? { autoFinalize: input.autoFinalize } : {}),
        ...(input.autoSend !== undefined ? { autoSend: input.autoSend } : {}),
        ...(input.emailTemplateId !== undefined ? { emailTemplateId: input.emailTemplateId } : {}),
        ...(input.showPeriodText !== undefined ? { showPeriodText: input.showPeriodText } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(sync && sync.create.length > 0 ? { lines: { create: sync.create.flatMap((index) => (lineRows[index] ? [lineRows[index]] : [])) } } : {}),
      },
      include: { lines: { orderBy: { position: "asc" } } },
    });
  }).then(async (updated) => {
    // Fix-Welle (Nit): RECURRING ist eine deklarierte ActivityEntityType, hatte aber
    // keinen Schreiber fuer Abo-Bearbeitungen — die Timeline eines Abos zeigte bisher
    // keinerlei UPDATED-Eintraege. Ausserhalb der Transaktion (logActivity() wirft nie,
    // siehe S8) — die Aenderung ist zu diesem Zeitpunkt bereits committet.
    await logActivity(dbInternal, { orgId, entityType: "RECURRING", entityId: id, type: "UPDATED", actor });
    return updated;
  });
}
