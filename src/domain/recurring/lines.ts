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
  taxRate: number;
  taxCategory: string;
  discountPermille: number;
  discountCents: number;
  ossCategory: OssCategory | null;
};

/** Gespeicherte Zeile (Teilmenge der Prisma-Zeile, die der Lauf braucht). */
export type RecurringStoredLine = {
  lineType: string;
  productId: string | null;
  description: string;
  descriptionLong: string | null;
  articleNumber: string | null;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number;
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
export function toRecurringLineRows(lines: readonly InvoiceLineInput[], ossCategories: readonly (OssCategory | null)[]): RecurringLineRow[] {
  return normalizeLines(lines).map((l, i) => {
    const isItem = l.lineType === "ITEM";
    return {
      position: l.position,
      lineType: l.lineType,
      productId: l.productId ?? null,
      description: l.description,
      descriptionLong: l.descriptionLong ?? null,
      articleNumber: l.articleNumber ?? null,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
      ossCategory: isItem ? (ossCategories[i] ?? null) : null,
    };
  });
}

/** Gespeicherte Zeilen 1:1 als Rechnungszeilen (Typ, Langtext, Art.-Nr., Rabatte, Produktbezug). */
export function recurringLinesToInvoiceLines(rows: readonly RecurringStoredLine[]): CreateInvoiceInput["lines"] {
  return rows.map((l) => {
    const lineType = toLineType(l.lineType);
    const isItem = lineType === "ITEM";
    return {
      lineType,
      productId: l.productId ?? undefined,
      description: l.description,
      descriptionLong: l.descriptionLong ?? undefined,
      articleNumber: l.articleNumber ?? undefined,
      quantityMilli: isItem ? l.quantityMilli : 0,
      unit: l.unit,
      unitNetPriceCents: isItem ? l.unitNetPriceCents : 0,
      taxRate: isItem ? l.taxRate : 0,
      taxCategory: l.taxCategory as CreateInvoiceInput["lines"][number]["taxCategory"],
      discountPermille: isItem ? l.discountPermille : 0,
      discountCents: isItem ? l.discountCents : 0,
      ossCategory: isItem ? parseOss(l.ossCategory) : undefined,
    };
  });
}

/** Steuersaetze der ITEM-Zeilen (Gliederungszeilen tragen 0 und erben keinen Satz). */
export function itemTaxRates(rows: readonly { lineType: string; taxRate: number }[]): number[] {
  const out = new Set<number>();
  for (const r of rows) if (toLineType(r.lineType) === "ITEM") out.add(r.taxRate);
  return [...out];
}
