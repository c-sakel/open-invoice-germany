/**
 * Produkt-Import (Phase 18b): Zeile -> Eingabe, Pruefung mit dem bestehenden `productSchema` und der
 * org-spezifischen Steuersatz-Freigabe, Duplikaterkennung der Artikelnummer gegen Bestand (inkl.
 * archivierter Produkte) und gegen frueher in der Datei. Kein Update bestehender Produkte.
 */
import { productSchema, type ProductInput } from "@/schemas";
import { parseDecimalInput } from "@/lib/money";
import { unitCodeFromInput } from "@/lib/units";
import { assertAllowedTaxRates, TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import { PRODUCT_IMPORT_COLUMNS, parseTaxRateCell, parseYesNoCell } from "./columns";
import { cellValue, headerOf, zodProblems, type ColumnIndex, type ImportRowError, type ParsedRow, type RowProblem } from "./types";
import type { ImportDb, ValidatedRows } from "./contacts-import";

const KEY_MAP: Record<string, string> = { netPriceCents: "netPrice", differential: "marginScheme" };
const h = (key: string) => headerOf(PRODUCT_IMPORT_COLUMNS, key);

export function productRowToInput(cells: readonly string[], index: ColumnIndex): { input: Record<string, unknown> } | { errors: RowProblem[] } {
  const errors: RowProblem[] = [];
  const get = (key: string) => cellValue(cells, index, key);
  const input: Record<string, unknown> = {
    name: get("name"),
    description: get("description"),
    articleNumber: get("articleNumber"),
    taxCategory: get("taxCategory")?.toUpperCase(),
    ossCategory: get("ossCategory")?.toUpperCase(),
  };
  const unit = get("unit");
  if (unit !== undefined) input.unit = unitCodeFromInput(unit);
  const price = get("netPrice");
  if (price !== undefined) {
    const cents = parseDecimalInput(price, 2);
    if (cents === null) errors.push({ column: h("netPrice"), message: "Ungültiger Betrag (z. B. 1.234,56)" });
    else input.netPriceCents = cents;
  }
  const rate = get("taxRate");
  if (rate !== undefined) {
    const n = parseTaxRateCell(rate);
    if (n === null) errors.push({ column: h("taxRate"), message: "Ganzzahliger Steuersatz von 0 bis 100 erwartet" });
    else input.taxRate = n;
  }
  const margin = parseYesNoCell(get("marginScheme") ?? "");
  if (margin === null) errors.push({ column: h("marginScheme"), message: "ja oder nein erwartet" });
  else input.differential = margin;
  return errors.length > 0 ? { errors } : { input };
}

export async function validateProductRows(db: ImportDb, orgId: string, rows: readonly ParsedRow[], index: ColumnIndex): Promise<ValidatedRows<ProductInput>> {
  const existing = await db.product.findMany({ where: { orgId }, select: { articleNumber: true } });
  const numbers = new Set<string>();
  for (const p of existing) if (p.articleNumber) numbers.add(p.articleNumber);
  const seen = new Map<string, number>();
  const explicit = new Set<string>();
  const candidates: { line: number; value: ProductInput; problems: RowProblem[] }[] = [];
  const errors: ImportRowError[] = [];

  for (const row of rows) {
    const mapped = productRowToInput(row.cells, index);
    if ("errors" in mapped) {
      for (const p of mapped.errors) errors.push({ line: row.line, column: p.column, message: p.message });
      continue;
    }
    const parsed = productSchema.safeParse(mapped.input);
    if (!parsed.success) {
      for (const p of zodProblems(parsed.error, PRODUCT_IMPORT_COLUMNS, KEY_MAP)) errors.push({ line: row.line, column: p.column, message: p.message });
      continue;
    }
    const problems: RowProblem[] = [];
    const num = parsed.data.articleNumber?.trim();
    if (num) {
      const first = seen.get(num);
      if (numbers.has(num)) problems.push({ column: h("articleNumber"), message: "Artikelnummer bereits vergeben" });
      else if (first !== undefined) problems.push({ column: h("articleNumber"), message: `Artikelnummer doppelt in Zeile ${first}` });
      else {
        seen.set(num, row.line);
        explicit.add(num);
      }
    }
    candidates.push({ line: row.line, value: parsed.data, problems });
  }

  // Steuersatz-Freigabe je distinctem Satz (ein Lesezugriff), Fehler auf alle Zeilen mit dem Satz.
  const rejectedRates = new Map<number, string>();
  for (const rate of new Set(candidates.map((c) => c.value.taxRate))) {
    try {
      await assertAllowedTaxRates(db, orgId, [rate]);
    } catch (e) {
      if (!(e instanceof TaxRateNotAllowedError)) throw e;
      rejectedRates.set(rate, e.message);
    }
  }
  const valid: { line: number; value: ProductInput }[] = [];
  for (const c of candidates) {
    const rateMsg = rejectedRates.get(c.value.taxRate);
    if (rateMsg) c.problems.push({ column: h("taxRate"), message: rateMsg });
    if (c.problems.length > 0) for (const p of c.problems) errors.push({ line: c.line, column: p.column, message: p.message });
    else valid.push({ line: c.line, value: c.value });
  }
  errors.sort((a, b) => a.line - b.line);
  return { valid, errors, taken: new Set([...numbers, ...explicit]) };
}
