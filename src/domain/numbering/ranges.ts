/**
 * Nummernkreis-Domain (Phase 7, Task 1, §34) — Uebersicht/Pflege der Nummernkreise
 * (Belege + Kunden-/Artikelnummern) und deren Vergabe fuer Kunden/Produkte. Die
 * transaktionale Vergabe fuer Belege selbst (Invoice/Quote/DeliveryNote/Dunning) bleibt
 * unveraendert in den jeweiligen finalize/status-Domain-Funktionen (upsert-increment auf
 * NumberRange) — hier nur die Verwaltung der Muster/Vorschau/Rueckstell-Guards sowie
 * dieselbe upsert-increment-Vergabe fuer Kunden-/Artikelnummern.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { InvalidOperationError } from "@/domain/errors";
import { defaultPattern, formatDocumentNumber } from "@/domain/numbering";
import { NUMBER_RANGE_DOC_TYPES, NumberRangeDocType, numberRangeInputSchema, type NumberRangeInput } from "@/schemas/settings";

export { NUMBER_RANGE_DOC_TYPES };
export type { NumberRangeDocType };

type Db = PrismaClient | Prisma.TransactionClient;

export interface NumberRangeView {
  docType: NumberRangeDocType;
  pattern: string;
  prefix: string;
  seqPadding: number;
  yearlyReset: boolean;
  currentValue: number;
  nextNumberPreview: string;
}

/**
 * Liest die "aktive" NumberRange-Zeile eines Nummernkreis-Typs — bei einem
 * yearlyReset-Wechsel bleiben beide Zeilen (year 0 und year <Jahr>) erhalten, die
 * zuletzt aktualisierte gilt als aktiv (siehe updateNumberRange).
 */
async function loadActiveRange(db: Db, orgId: string, docType: string, year: number) {
  const rows = await db.numberRange.findMany({ where: { orgId, docType, year: { in: [0, year] } } });
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}

/** Formatiert die naechste Nummer eines Musters (rein, ohne DB). */
export function previewNumber(input: { prefix: string; pattern: string; seqPadding: number }, seq: number, date: Date): string {
  return formatDocumentNumber(input.pattern, {
    prefix: input.prefix,
    seq,
    padding: input.seqPadding,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

/** Uebersicht aller Nummernkreise einer Organisation fuer das angegebene Geschaeftsjahr. */
export async function listNumberRanges(orgId: string, year: number): Promise<NumberRangeView[]> {
  const previewDate = new Date(Date.UTC(year, 0, 1));
  const views: NumberRangeView[] = [];
  for (const docType of NUMBER_RANGE_DOC_TYPES) {
    const fallback = defaultPattern(docType);
    const row = await loadActiveRange(dbInternal, orgId, docType, year);
    const pattern = row?.pattern ?? fallback.pattern;
    const prefix = row?.prefix ?? fallback.prefix;
    const seqPadding = row?.seqPadding ?? fallback.seqPadding;
    const yearlyReset = row ? row.year !== 0 : fallback.yearlyReset;
    const currentValue = row?.currentValue ?? 0;
    views.push({
      docType,
      pattern,
      prefix,
      seqPadding,
      yearlyReset,
      currentValue,
      nextNumberPreview: previewNumber({ prefix, pattern, seqPadding }, currentValue + 1, previewDate),
    });
  }
  return views;
}

/**
 * Aktualisiert Muster/Praefix/Polsterung/yearlyReset/naechste-Nummer eines
 * Nummernkreises. Guards (GoBD, §14 Abs.4 Nr.4 — Nummern duerfen nie zurueckgedreht
 * werden): `nextValue - 1` muss >= dem bisherigen `currentValue` der Zielzeile sein;
 * fuer INVOICE/CREDIT_NOTE zusaetzlich >= dem hoechsten je in diesem Jahr vergebenen
 * Wert (ueber beide moeglichen Zeilen year 0/year <Jahr>), damit ein yearlyReset-
 * Wechsel keine bereits vergebene Rechnungsnummer erneut vergeben kann.
 */
export async function updateNumberRange(
  orgId: string,
  docType: string,
  rawInput: unknown,
  actor: string,
  now: Date = new Date(),
): Promise<NumberRangeView> {
  NumberRangeDocType.parse(docType);
  const input: NumberRangeInput = numberRangeInputSchema.parse(rawInput);
  const year = now.getFullYear();
  const targetYear = input.yearlyReset ? year : 0;

  return dbInternal.$transaction(async (tx) => {
    const before = await loadActiveRange(tx, orgId, docType, year);
    const target = await tx.numberRange.findUnique({ where: { orgId_docType_year: { orgId, docType, year: targetYear } } });

    const targetCurrentValue = target?.currentValue ?? 0;
    if (input.nextValue - 1 < targetCurrentValue) {
      throw new InvalidOperationError(
        `Nummernkreis "${docType}" kann nicht zurueckgedreht werden: naechste Nummer waere ${input.nextValue}, ` +
          `es wurden bereits ${targetCurrentValue} Nummern vergeben.`,
      );
    }
    if (docType === "INVOICE" || docType === "CREDIT_NOTE") {
      const rowsThisYear = await tx.numberRange.findMany({ where: { orgId, docType, year: { in: [0, year] } } });
      const maxAssigned = rowsThisYear.reduce((max, r) => Math.max(max, r.currentValue), 0);
      if (input.nextValue - 1 < maxAssigned) {
        throw new InvalidOperationError(
          `Nummernkreis "${docType}" kann nicht unter die bereits vergebene Nummer ${maxAssigned} dieses Jahres gesetzt werden.`,
        );
      }
    }

    const newCurrentValue = input.nextValue - 1;
    const written = await tx.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: targetYear } },
      create: {
        orgId,
        docType,
        year: targetYear,
        pattern: input.pattern,
        prefix: input.prefix,
        seqPadding: input.seqPadding,
        currentValue: newCurrentValue,
      },
      update: {
        pattern: input.pattern,
        prefix: input.prefix,
        seqPadding: input.seqPadding,
        currentValue: newCurrentValue,
      },
    });

    await appendChangeLog(tx, {
      orgId,
      entity: "SETTINGS",
      entityId: `NUMBER_RANGE:${docType}`,
      action: "UPDATE",
      actor,
      at: now,
      diff: {
        before: before
          ? { pattern: before.pattern, prefix: before.prefix, seqPadding: before.seqPadding, yearlyReset: before.year !== 0, currentValue: before.currentValue }
          : null,
        after: { pattern: written.pattern, prefix: written.prefix, seqPadding: written.seqPadding, yearlyReset: written.year !== 0, currentValue: written.currentValue },
      },
    });

    const previewDate = new Date(Date.UTC(year, 0, 1));
    return {
      docType: docType as NumberRangeDocType,
      pattern: written.pattern,
      prefix: written.prefix,
      seqPadding: written.seqPadding,
      yearlyReset: written.year !== 0,
      currentValue: written.currentValue,
      nextNumberPreview: previewNumber(written, written.currentValue + 1, previewDate),
    };
  });
}

/** Vergibt (upsert-increment, wie Belege) die naechste Kundennummer einer Organisation. */
export async function assignCustomerNumber(tx: Db, orgId: string, now: Date = new Date()): Promise<string> {
  return assignRangeNumber(tx, orgId, "CUSTOMER", now);
}

/** Vergibt (upsert-increment, wie Belege) die naechste Artikelnummer einer Organisation. */
export async function assignArticleNumber(tx: Db, orgId: string, now: Date = new Date()): Promise<string> {
  return assignRangeNumber(tx, orgId, "PRODUCT", now);
}

async function assignRangeNumber(tx: Db, orgId: string, docType: "CUSTOMER" | "PRODUCT", now: Date): Promise<string> {
  const fallback = defaultPattern(docType);
  const active = await loadActiveRange(tx, orgId, docType, now.getFullYear());
  const year = active ? active.year : fallback.yearlyReset ? now.getFullYear() : 0;
  const range = await tx.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType, year } },
    create: {
      orgId,
      docType,
      year,
      currentValue: 1,
      prefix: fallback.prefix,
      pattern: fallback.pattern,
      seqPadding: fallback.seqPadding,
    },
    update: { currentValue: { increment: 1 } },
  });
  return formatDocumentNumber(range.pattern, {
    prefix: range.prefix || fallback.prefix,
    seq: range.currentValue,
    padding: range.seqPadding,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  });
}
