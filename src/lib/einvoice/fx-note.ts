/**
 * Fremdwaehrungsbelege (Phase 16b): BT-22-Kursnotiz und EUR-Betrag der Steuer (BT-111).
 * Gemeinsame Quelle fuer UBL und CII. Beim Gutschrift-Typ stehen alle XML-Betraege positiv
 * (EN-16931-Konvention), daher auch die EUR-Steuer.
 */
import { docLocale, docStrings, formatDocDate } from "@/lib/i18n/doc";
import { formatRate } from "@/domain/fx/decimal";
import type { EInvoiceData, EInvoiceFx } from "./types";
import type { DocLanguage } from "@/lib/i18n/doc";

/** Der Fremdwaehrungsblock, sofern der Beleg wirklich in Fremdwaehrung lautet; sonst null. */
export function fxOf(data: EInvoiceData): EInvoiceFx | null {
  return data.fx && data.currency !== "EUR" ? data.fx : null;
}

/**
 * BT-22: "Umrechnungskurs: 1 EUR = 1,1214 USD (Monatsdurchschnittskurs Juni 2034)" — beim
 * Monatsdurchschnitt dieselbe neutrale Formulierung wie im PDF (`fxPdfRateLine`), ohne Behoerdenangabe:
 * der Wert ist standardmaessig ein selbst berechnetes Mittel der EZB-Tageskurse.
 */
export function fxRateNoteText(data: EInvoiceData, fx: EInvoiceFx): string {
  const lang = data.language ?? "de";
  if (fx.source === "BMF_MONTHLY") return fxPdfRateLine(lang, data.currency, fx);
  const t = docStrings(lang).fx;
  return t.rateLine(formatRate(fx.rateMicros, docLocale(lang)), data.currency, t.sourceLabel[fx.source], formatDocDate(fx.rateDate, lang));
}

/**
 * PDF-Kurszeile: beim Monatsdurchschnitt nennt das Label den Monat ("Monatsdurchschnittskurs
 * März 2109", Monat des tatsaechlich verwendeten Kurses, auch beim Vormonats-Fallback), sonst
 * Quelle plus Kursdatum. Der Kurs selbst ist der eingefrorene Beleg-Kurs.
 */
export function fxPdfRateLine(lang: DocLanguage, currency: string, fx: EInvoiceFx): string {
  const t = docStrings(lang).fx;
  const rate = formatRate(fx.rateMicros, docLocale(lang));
  if (fx.source === "BMF_MONTHLY") {
    return t.rateLine(rate, currency, t.monthlyRateLabel(fx.rateDate.getUTCFullYear(), fx.rateDate.getUTCMonth() + 1), "");
  }
  return t.rateLine(rate, currency, t.sourceLabel[fx.source], formatDocDate(fx.rateDate, lang));
}
