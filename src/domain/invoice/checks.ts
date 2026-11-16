/**
 * Reine Belegpruefungen ohne Datenbankzugriff: Kleinbetragsrechnung (§ 33 UStDV), Ausstellfrist bei
 * innergemeinschaftlichen Lieferungen und Leistungen (§ 14a Abs. 1, 3 UStG) und Aufloesung des
 * Verzugshinweises fuer Verbraucher (§ 286 Abs. 3 BGB). Die Pruefungen kennzeichnen nur; sie lockern
 * keine Pflichtangaben und blockieren nie.
 */
import { berlinDateKey, berlinMidnight, berlinParts } from "@/lib/berlin-time";
import { isOssBuyer } from "@/domain/reporting/oss-calc";

/** Kleinbetragsrechnung: Gesamtbetrag bis 250,00 EUR brutto (§ 33 S. 1 UStDV). */
export const SMALL_AMOUNT_LIMIT_CENTS = 25_000;

const SMALL_AMOUNT_EXCLUDED_SCHEMES = new Set(["IG_LIEFERUNG", "REVERSE_CHARGE", "IG_LEISTUNG"]);
const DEADLINE_SCHEMES = new Set(["IG_LIEFERUNG", "IG_LEISTUNG"]);
const INVOICE_FAMILY_TYPES = new Set(["INVOICE", "PARTIAL", "DOWNPAYMENT", "FINAL"]);

/** Brutto in EUR: EUR-Beleg = Bruttosumme, Fremdwaehrung = eingefrorene EUR-Werte (fehlt einer -> null). */
export function grossEurCentsOf(i: {
  currency: string;
  grossTotalCents: number;
  netTotalEurCents: number | null;
  taxTotalEurCents: number | null;
}): number | null {
  if (i.currency === "EUR") return i.grossTotalCents;
  if (i.netTotalEurCents === null || i.taxTotalEurCents === null) return null;
  return i.netTotalEurCents + i.taxTotalEurCents;
}

export function isSmallAmountInvoice(i: {
  type: string;
  taxScheme: string;
  grossEurCents: number | null;
  buyer: { countryCode: string | null; vatId: string | null } | null;
}): boolean {
  if (i.type !== "INVOICE") return false;
  if (i.grossEurCents === null || i.grossEurCents <= 0 || i.grossEurCents > SMALL_AMOUNT_LIMIT_CENTS) return false;
  if (SMALL_AMOUNT_EXCLUDED_SCHEMES.has(i.taxScheme)) return false;
  // § 33 S. 3 UStDV: nicht bei Lieferungen an EU-Privatkunden im Ausland (Fernverkauf).
  if (i.buyer && i.buyer.countryCode && isOssBuyer({ countryCode: i.buyer.countryCode, vatId: i.buyer.vatId })) return false;
  return true;
}

/**
 * Letzter Tag fuer die Ausstellung: 15. Tag des Monats nach der Leistung (Berliner Kalendertag,
 * 00:00 Uhr Berliner Zeit). Nur bei ig. Lieferung/Leistung; ohne Leistungsdatum null.
 */
export function issueDeadline(i: { taxScheme: string; deliveryDate: Date | null; deliveryEnd: Date | null }): Date | null {
  if (!DEADLINE_SCHEMES.has(i.taxScheme)) return null;
  const base = i.deliveryEnd ?? i.deliveryDate;
  if (!base) return null;
  const { year, month } = berlinParts(base);
  return berlinMidnight(year, month + 1, 15);
}

/** Verpasst, wenn der Berliner Kalendertag des Belegdatums nach dem Fristtag liegt. */
export function isIssueDeadlineMissed(deadline: Date | null, issueDate: Date): boolean {
  if (!deadline) return false;
  return berlinDateKey(issueDate) > berlinDateKey(deadline);
}

/** Verzugshinweis (§ 286 Abs. 3 BGB): Entwurf = Vorgabe oder automatisch; festgeschrieben = nur der eingefrorene Wert. */
export function resolveConsumerDefaultNotice(i: {
  status: string;
  type: string;
  stored: boolean | null;
  customerType: string;
  settingEnabled: boolean;
}): boolean {
  if (!INVOICE_FAMILY_TYPES.has(i.type)) return false;
  if (i.status !== "DRAFT") return i.stored === true;
  return i.stored ?? (i.customerType === "CONSUMER" && i.settingEnabled);
}
