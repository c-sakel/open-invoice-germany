/**
 * Geld- und Mengen-Arithmetik in Ganzzahlen.
 *
 * Geldbeträge werden durchgängig in **Cent** (Integer) gehalten, Mengen in
 * **Milliunits** (1/1000, Integer). Damit gibt es keine Float-Rundungsfehler
 * und das Modell ist zwischen SQLite und PostgreSQL portabel.
 */

export const CENTS_PER_EURO = 100;
export const MILLI = 1000;

/** Kaufmännische Rundung (half-up, symmetrisch um 0). */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Formatiert Cent als lokalisierten Währungs-String (Default de-DE/EUR). */
export function formatCents(cents: number, currency = "EUR", locale = "de-DE"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / CENTS_PER_EURO);
}

/**
 * Kompakte Kurzform fuer schmale Achsenbeschriftungen (Fix I5, Abschluss-Review, BarChart-
 * y-Achse): ab 1.000 € "x,y k€" (eine Nachkommastelle), darunter der volle `formatCents`-
 * String — eine vierstellige Beschriftung ("1.234,56 €") sprengt sonst die schmale y-Achse.
 * Vorzeichen bleibt erhalten ("-1,2 k€").
 */
export function formatCentsShort(cents: number, locale = "de-DE"): string {
  if (Math.abs(cents) < CENTS_PER_EURO * 1000) return formatCents(cents);
  const thousandEuros = cents / (CENTS_PER_EURO * 1000);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(thousandEuros)} k€`;
}

/** Parst eine deutsche/englische Geldeingabe ("1.234,56" oder "1234.56") nach Cent. */
export function parseEuroToCents(input: string): number {
  const cleaned = input.trim().replace(/\s|€/g, "");
  // Deutsches Format mit Komma als Dezimaltrenner
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error(`Ungültiger Geldbetrag: ${input}`);
  return roundHalfUp(value * CENTS_PER_EURO);
}

/** Menge (Milliunits) als String mit bis zu 3 Nachkommastellen. */
export function formatQuantity(quantityMilli: number, locale = "de-DE"): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(quantityMilli / MILLI);
}

/**
 * Parst eine Formulareingabe (Geld, Menge, Prozent) in Ganzzahl-Einheiten mit `decimals`
 * Nachkommastellen: decimals=2 -> Cent, 3 -> Milliunits, 1 -> Promille.
 * - Mit Komma: deutsches Format, Punkte sind Tausendertrenner ("1.234,56").
 * - Ohne Komma: ein Punkt ist Dezimaltrenner ("1234.56", Vorbelegung per toFixed),
 *   mehrere Punkte sind Tausendertrenner ("1.234.567").
 * Mehr Nachkommastellen als erlaubt, leere oder unsinnige Eingaben ergeben `null` —
 * niemals still einen falschen Betrag (z. B. "1.234" bei Geld nicht als 1,23 EUR).
 */
export function parseDecimalInput(input: string, decimals: number): number | null {
  const cleaned = input.replace(/[\s€% ]/g, "");
  if (cleaned === "") return null;
  let normalized: string;
  if (cleaned.includes(",")) {
    if (!/^-?\d{1,3}(\.\d{3})*,\d+$|^-?\d+,\d+$/.test(cleaned)) return null;
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if ((cleaned.match(/\./g) ?? []).length > 1) {
    if (!/^-?\d{1,3}(\.\d{3})+$/.test(cleaned)) return null;
    normalized = cleaned.replace(/\./g, "");
  } else {
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    normalized = cleaned;
  }
  const fraction = normalized.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return roundHalfUp(value * 10 ** decimals);
}

/** Parst eine Mengeneingabe ("2,5" oder "2.5") nach Milliunits. */
export function parseQuantityToMilli(input: string): number {
  const cleaned = input.trim().replace(/\s/g, "");
  // Tausenderpunkte nur entfernen, wenn ein Komma als Dezimaltrenner vorhanden ist.
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error(`Ungültige Menge: ${input}`);
  return roundHalfUp(value * MILLI);
}
