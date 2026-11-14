/**
 * Positionen von Abo-Vorlagen (Phase 18c): rein, ohne Datenbankzugriff.
 *
 * Eine Abo-Zeile kann wie eine Rechnungszeile ITEM, HEADING, TEXT oder SUBTOTAL sein.
 * Gliederungszeilen tragen nie einen Betrag (gleiches `normalizeLines` wie bei Rechnungen);
 * Steuersaetze und Netto zaehlen nur fuer ITEM-Zeilen. Der Lauf kopiert die gespeicherten
 * Zeilen 1:1 in die Rechnung — Berechnung und Pruefung uebernimmt danach der gemeinsame
 * Rechnungspfad (`createDraftInvoiceWithinTx`).
 */
import { normalizeLines } from "@/domain/document/lines";
import { parseOss } from "@/domain/product/oss-snapshot";
import type { CreateInvoiceInput, InvoiceLineInput, LineType } from "@/schemas";
import type { OssCategory } from "@/schemas/oss";
import { RecurringError } from "@/domain/recurring/errors";

export type RecurringBilling = "FIXED" | "USAGE";

/** Zeile so, wie sie in `RecurringInvoiceLine` gespeichert wird (ohne Id/Fremdschluessel). */
export type RecurringLineRow = {
  position: number;
  lineType: LineType;
  productId: string | null;
  description: string;
  descriptionLong: string | null;
  articleNumber: string | null;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number;
  /** Phase 18f: Einzelpreis in tausendstel Cent (Durchreichen; Verbrauchslogik folgt in Task 5). */
  unitNetPriceMilliCents: number | null;
  taxRate: number;
  taxCategory: string;
  discountPermille: number;
  discountCents: number;
  ossCategory: OssCategory | null;
  /** Phase 18f: FIXED = feste Menge, USAGE = Menge aus den Verbraeuchen des Zeitraums. */
  billing: RecurringBilling;
  usageUnitLabel: string | null;
};

/** Gespeicherte Zeile (Teilmenge der Prisma-Zeile, die der Lauf braucht). */
export type RecurringStoredLine = {
  id?: string;
  billing?: string;
  usageUnitLabel?: string | null;
  lineType: string;
  productId: string | null;
  description: string;
  descriptionLong: string | null;
  articleNumber: string | null;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number;
  unitNetPriceMilliCents?: number | null;
  taxRate: number;
  taxCategory: string;
  discountPermille: number;
  discountCents: number;
  ossCategory: string | null;
};

const LINE_TYPES: readonly LineType[] = ["ITEM", "HEADING", "TEXT", "SUBTOTAL"];

function toLineType(value: string): LineType {
  return LINE_TYPES.find((t) => t === value) ?? "ITEM";
}

/**
 * Eingabezeilen (Kategorie bereits abgeleitet) in Speicherzeilen. `ossCategories` ist parallel
 * zu `lines`; die OSS-Kategorie wird nur fuer ITEM gespeichert.
 */
export function toRecurringLineRows(
  lines: readonly (InvoiceLineInput & { billing?: RecurringBilling; usageUnitLabel?: string })[],
  ossCategories: readonly (OssCategory | null)[],
): RecurringLineRow[] {
  return normalizeLines(lines).map((l, i) => {
    const isItem = l.lineType === "ITEM";
    const usage = isItem && lines[i]?.billing === "USAGE";
    return {
      position: l.position,
      lineType: l.lineType,
      productId: l.productId ?? null,
      description: l.description,
      descriptionLong: l.descriptionLong ?? null,
      articleNumber: l.articleNumber ?? null,
      quantityMilli: usage ? 0 : l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents,
      unitNetPriceMilliCents: l.unitNetPriceMilliCents ?? null,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
      ossCategory: isItem ? (ossCategories[i] ?? null) : null,
      billing: usage ? "USAGE" : "FIXED",
      usageUnitLabel: usage ? (lines[i]?.usageUnitLabel ?? null) : null,
    };
  });
}

/** Summe der offenen Verbraeuche einer Abo-Zeile mit Zeitraum (Phase 18f). */
export type BillableUsage = { quantityMilli: number; periodStart: Date; periodEnd: Date };

/**
 * Gespeicherte Zeilen 1:1 als Rechnungszeilen (Typ, Langtext, Art.-Nr., Rabatte, Produktbezug).
 * Phase 18f: USAGE-Zeilen tragen Menge = Summe der Verbraeuche und deren Zeitraum (BG-26);
 * ohne Verbrauch entfallen sie. Ohne `usage`-Map (Altaufrufer) entfallen alle USAGE-Zeilen.
 */
export function recurringLinesToInvoiceLines(
  rows: readonly RecurringStoredLine[],
  usage?: ReadonlyMap<string, BillableUsage>,
): CreateInvoiceInput["lines"] {
  const out: CreateInvoiceInput["lines"] = [];
  for (const l of rows) {
    const lineType = toLineType(l.lineType);
    const isItem = lineType === "ITEM";
    let quantityMilli = isItem ? l.quantityMilli : 0;
    let servicePeriodStart: Date | undefined;
    let servicePeriodEnd: Date | undefined;
    if (isItem && l.billing === "USAGE") {
      const used = l.id ? usage?.get(l.id) : undefined;
      if (!used) continue;
      quantityMilli = used.quantityMilli;
      servicePeriodStart = used.periodStart;
      servicePeriodEnd = used.periodEnd;
    }
    out.push({
      lineType,
      productId: l.productId ?? undefined,
      description: l.description,
      descriptionLong: l.descriptionLong ?? undefined,
      articleNumber: l.articleNumber ?? undefined,
      quantityMilli,
      unit: l.unit,
      unitNetPriceCents: isItem ? l.unitNetPriceCents : 0,
      unitNetPriceMilliCents: isItem ? (l.unitNetPriceMilliCents ?? null) : null,
      servicePeriodStart,
      servicePeriodEnd,
      taxRate: isItem ? l.taxRate : 0,
      taxCategory: l.taxCategory as CreateInvoiceInput["lines"][number]["taxCategory"],
      discountPermille: isItem ? l.discountPermille : 0,
      discountCents: isItem ? l.discountCents : 0,
      ossCategory: isItem ? parseOss(l.ossCategory) : undefined,
    });
  }
  return out;
}

/**
 * Abgleich der Abo-Zeilen beim Bearbeiten (Phase 18f): vorhandene Zeilen behalten ihre Id
 * (Verbrauchssaetze verweisen darauf), neue entstehen, fehlende entfallen. Eine USAGE-Zeile mit
 * offenen Verbraeuchen darf weder entfernt noch auf FIXED umgestellt werden; fremde oder
 * doppelte Ids werden abgelehnt. `create` nennt die Indizes der Eingabezeilen ohne Id.
 */
export function planLineSync(
  existing: readonly { id: string; billing: string; openUsage: number }[],
  input: readonly { id?: string; billing?: RecurringBilling }[],
): { update: string[]; create: number[]; delete: string[] } {
  const known = new Map(existing.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const update: string[] = [];
  const create: number[] = [];
  input.forEach((line, index) => {
    if (line.id === undefined) {
      create.push(index);
      return;
    }
    const row = known.get(line.id);
    if (!row) throw new RecurringError("Unbekannte Positions-Id im Abo.");
    if (seen.has(line.id)) throw new RecurringError("Positions-Id mehrfach angegeben.");
    seen.add(line.id);
    if (row.billing === "USAGE" && line.billing !== "USAGE" && row.openUsage > 0) {
      throw new RecurringError("Die Position hat offene Verbräuche und kann nicht auf feste Menge umgestellt werden.");
    }
    update.push(line.id);
  });
  const remove: string[] = [];
  for (const e of existing) {
    if (seen.has(e.id)) continue;
    if (e.billing === "USAGE" && e.openUsage > 0) {
      throw new RecurringError("Die Position hat offene Verbräuche und kann nicht entfernt werden.");
    }
    remove.push(e.id);
  }
  return { update, create, delete: remove };
}

/** Steuersaetze der ITEM-Zeilen (Gliederungszeilen tragen 0 und erben keinen Satz). */
export function itemTaxRates(rows: readonly { lineType: string; taxRate: number }[]): number[] {
  const out = new Set<number>();
  for (const r of rows) if (toLineType(r.lineType) === "ITEM") out.add(r.taxRate);
  return [...out];
}
