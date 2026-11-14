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

/**
 * Parst eine deutsche/englische Geldeingabe ("1.234,56" oder "1234.56") nach Cent.
 * Wirft bei leerer, unsinniger oder mehrdeutiger Eingabe ("1.234") — siehe parseDecimalInput.
 */
export function parseEuroToCents(input: string): number {
  const cents = parseDecimalInput(input, 2);
  if (cents === null) throw new Error(`Ungültiger Geldbetrag: ${input}`);
  return cents;
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
 * Mehr Nachkommastellen werden kaufmaennisch gerundet ("2,55" % -> 26 Promille).
 * Leere, unsinnige oder mehrdeutige Eingaben ("1.234" bei Geld/Prozent) ergeben `null` —
 * niemals still einen falschen Betrag (z. B. "1.234" bei Geld nicht als 1,23 EUR).
 */
export function parseDecimalInput(input: string, decimals: number): number | null {
  const cleaned = input.replace(/[\s€%]/g, "");
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
  // Mehrdeutig: genau ein Punkt mit genau drei Ziffern und kein Komma ("1.234") — Tausender-
  // oder Dezimaltrenner? Bei weniger als 3 erlaubten Nachkommastellen ablehnen statt raten.
  if (decimals < 3 && !cleaned.includes(",") && /^-?\d{1,3}\.\d{3}$/.test(cleaned)) return null;
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

// ---------------------------------------------------------------------------
// Einzelpreise in tausendstel Cent ("Milli-Cent", Phase 18f)
//
// Ein Einzelpreis kann feiner als ein Cent sein (z. B. 0,002 EUR = 200 Milli-Cent).
// Ganzzahlig gespeichert: 1 EUR = 100 Cent = 100.000 Milli-Cent. Produkte
// (Menge x Preis) laufen ueber BigInt, damit nichts ueber 2^53 still ungenau wird.
// ---------------------------------------------------------------------------

export const MILLI_CENTS_PER_CENT = 1000;
/** Obergrenze eines Einzelpreises in Milli-Cent (Int32, portabel in SQLite und Postgres). */
export const MAX_UNIT_PRICE_MILLI_CENTS = 2_147_483_647;

/**
 * round(a * b / divisor) kaufmaennisch (Half-Up, |x.5| weg von 0) ueber BigInt.
 * Wirft RangeError bei divisor <= 0, nicht ganzzahligen Eingaben oder wenn das Ergebnis
 * keine sichere Ganzzahl ist.
 */
export function mulDivRoundHalfUp(a: number, b: number, divisor: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(divisor) || divisor <= 0) {
    throw new RangeError(`mulDivRoundHalfUp erwartet Ganzzahlen und divisor > 0: ${a}, ${b}, ${divisor}`);
  }
  const num = BigInt(a) * BigInt(b);
  const d = BigInt(divisor);
  const negative = num < BigInt(0);
  const abs = negative ? -num : num;
  const q = (abs * BigInt(2) + d) / (BigInt(2) * d);
  const result = negative ? -q : q;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`mulDivRoundHalfUp: Ergebnis ausserhalb des sicheren Ganzzahlbereichs (${a} * ${b} / ${divisor})`);
  }
  return Number(result);
}

/** Milli-Cent -> Cent (kaufmaennisch gerundet). */
export function milliCentsToCents(milli: number): number {
  return mulDivRoundHalfUp(milli, 1, MILLI_CENTS_PER_CENT);
}

/** `null`, wenn kein Milli-Preis vorliegt oder er ein ganzer Cent ist (Bestandsformat). */
export function normalizeMilli(milli: number | null | undefined): number | null {
  if (milli === null || milli === undefined) return null;
  return milli % MILLI_CENTS_PER_CENT === 0 ? null : milli;
}

/** Milli-Cent als Dezimalstring mit 5 Nachkommastellen in EUR ("0.00200") — reine String-Arithmetik. */
export function milliCentsToDecimal(milli: number): string {
  const negative = milli < 0;
  const abs = String(Math.abs(milli)).padStart(6, "0");
  const text = `${abs.slice(0, -5)}.${abs.slice(-5)}`;
  return negative ? `-${text}` : text;
}

interface UnitPriceLike {
  unitNetPriceCents: number;
  unitNetPriceMilliCents?: number | null;
}

function unitPriceMilli(p: UnitPriceLike): number {
  return p.unitNetPriceMilliCents ?? p.unitNetPriceCents * MILLI_CENTS_PER_CENT;
}

/** Einzelpreis mit 2 bis 5 Nachkommastellen ("12,50 €", "0,002 €", "1.234,5678 €"). */
export function formatUnitPrice(p: UnitPriceLike, currency = "EUR", locale = "de-DE"): string {
  // Intl.NumberFormat v3 formatiert Dezimalstrings exakt (kein Float); die TS-Lib kennt das noch nicht.
  const exact = milliCentsToDecimal(unitPriceMilli(p)) as unknown as number;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 5,
  }).format(exact);
}

/** Vorbelegung des Preisfelds im Editor: "0,002" bzw. "12,50" (ohne Tausendertrenner). */
export function unitPriceToInput(p: UnitPriceLike, locale = "de-DE"): string {
  const decimal = milliCentsToDecimal(unitPriceMilli(p));
  const [int, frac] = decimal.split(".");
  let trimmed = frac.replace(/0+$/, "");
  if (trimmed.length < 2) trimmed = trimmed.padEnd(2, "0");
  const separator = locale.toLowerCase().startsWith("de") ? "," : ".";
  return `${int}${separator}${trimmed}`;
}

/**
 * Parst eine Einzelpreis-Eingabe mit bis zu 5 Nachkommastellen (EUR). Trennerregeln wie
 * `parseDecimalInput` (Komma = Dezimal, Punkte = Tausender; ein einzelner Punkt ohne Komma
 * ist Dezimal, ausser "1.234" mit Ganzzahlteil != 0 — mehrdeutig -> null). Mehr als
 * 5 Nachkommastellen, negative oder unsinnige Eingaben ergeben `null` (keine stille
 * Rundung). Der Bruchteil wird nie ueber Number geparst. Ganze Cent-Preise (hoechstens
 * 2 relevante Stellen) haben keine Obergrenze ausser dem sicheren Ganzzahlbereich.
 */
export function parseUnitPriceInput(input: string): { cents: number; milliCents: number | null } | null {
  const cleaned = input.replace(/[\s€]/g, "");
  if (cleaned === "") return null;
  let intPart: string;
  let fracPart = "";
  if (cleaned.includes(",")) {
    if (!/^\d{1,3}(\.\d{3})*,\d+$|^\d+,\d+$/.test(cleaned)) return null;
    const [i, f] = cleaned.split(",");
    intPart = i.replace(/\./g, "");
    fracPart = f;
  } else if ((cleaned.match(/\./g) ?? []).length > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(cleaned)) return null;
    intPart = cleaned.replace(/\./g, "");
  } else {
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    if (/^\d{1,3}\.\d{3}$/.test(cleaned) && !/^0\./.test(cleaned)) return null;
    const [i, f] = cleaned.split(".");
    intPart = i;
    fracPart = f ?? "";
  }
  if (fracPart.length > 5) return null;
  const milli = BigInt(intPart) * BigInt(100000) + BigInt(fracPart.padEnd(5, "0"));
  const whole = milli % BigInt(1000) === BigInt(0);
  if (!whole && milli > BigInt(MAX_UNIT_PRICE_MILLI_CENTS)) return null;
  const cents = (milli * BigInt(2) + BigInt(1000)) / BigInt(2000);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { cents: Number(cents), milliCents: whole ? null : Number(milli) };
}
