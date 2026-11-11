/**
 * Fremdwaehrungsbelege (Phase 16b): BT-22-Kursnotiz und EUR-Betrag der Steuer (BT-111).
 * Gemeinsame Quelle fuer UBL und CII. Beim Gutschrift-Typ stehen alle XML-Betraege positiv
 * (EN-16931-Konvention), daher auch die EUR-Steuer.
 */
import { docLocale, docStrings, formatDocDate } from "@/lib/i18n/doc";
import { formatRate } from "@/domain/fx/decimal";
import type { EInvoiceData, EInvoiceFx } from "./types";

/** Der Fremdwaehrungsblock, sofern der Beleg wirklich in Fremdwaehrung lautet; sonst null. */
export function fxOf(data: EInvoiceData): EInvoiceFx | null {
  return data.fx && data.currency !== "EUR" ? data.fx : null;
}

/** BT-22: "Umrechnungskurs: 1 EUR = 1,1214 USD (BMF-Monatsdurchschnittskurs vom 01.06.2034)". */
export function fxRateNoteText(data: EInvoiceData, fx: EInvoiceFx): string {
  const lang = data.language ?? "de";
  const t = docStrings(lang).fx;
  return t.rateLine(formatRate(fx.rateMicros, docLocale(lang)), data.currency, t.sourceLabel[fx.source], formatDocDate(fx.rateDate, lang));
}
