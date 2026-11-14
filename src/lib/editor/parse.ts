/**
 * Reine Parse-/Format-Helfer für Editor-Eingabefelder (Anzeige-String <-> Integer).
 *
 * Anders als `parseEuroToCents` (`@/lib/money`), das bei ungültiger Eingabe wirft, liefern die `toX`-Funktionen hier `null` — der Editor
 * muss ungültige Zwischenzustände beim Tippen abfangen können, ohne try/catch an
 * jeder Aufrufstelle (siehe `computeDraftTotals`/`validateDraft` in draft.ts/totals.ts).
 */
import { parseDecimalInput, parseUnitPriceInput, unitPriceToInput } from "@/lib/money";

/**
 * Euro-Eingabe ("12,50", "1.234,56", "12.50") -> Cent, oder `null` bei leerer/ungültiger Eingabe.
 * Mehr als zwei Nachkommastellen (z. B. "1.234" ohne Komma) sind mehrdeutig und ergeben `null`.
 */
export function toCents(input: string): number | null {
  return parseDecimalInput(input, 2);
}

/** Mengen-Eingabe ("2", "2,5") -> Milliunits, oder `null` bei leerer/ungültiger Eingabe. */
export function toMilli(input: string): number | null {
  return parseDecimalInput(input, 3);
}

/** Prozent-Eingabe ("10", "2,5") -> Promille (0..1000 = 0..100 %), oder `null` bei ungültiger Eingabe. */
export function toPermille(percent: string): number | null {
  return parseDecimalInput(percent, 1);
}

/** Cent -> lokalisierter Anzeige-String ohne Währungszeichen, immer 2 Nachkommastellen ("12,50"). */
export function fromCents(cents: number): string {
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/** Milliunits -> Anzeige-String mit bis zu 3 Nachkommastellen ohne überflüssige Nullen ("2" oder "2,5"). */
export function fromMilli(milli: number): string {
  // Ohne Tausenderpunkt: "1.234" waere beim Zurueckparsen 1,234 (Mengen haben 3 Nachkommastellen).
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3, useGrouping: false }).format(milli / 1000);
}

/** Promille -> Prozent-Anzeige-String mit bis zu einer Nachkommastelle ("2,5"). */
export function fromPermille(p: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(p / 10);
}

/**
 * "Oder Zero"-Varianten der `toCents`/`toMilli`/`toPermille`-Funktionen oben: ungültige/
 * leere Eingabe -> 0 statt null, `permilleOrZero` zusätzlich auf 0..1000 geklemmt.
 * Payload-Mapper (draft.ts) UND
 * Live-Summen (totals.ts) verwenden dieselben Funktionen, damit ein außerhalb des
 * gültigen Bereichs liegender Prozentwert (z. B. "150" %) in beiden konsistent auf
 * 100 % geklemmt wird statt in den Summen einen Fehler zu erzeugen, den das
 * eigentliche Speichern gar nicht widerspiegelt.
 */
export function centsOrZero(s: string): number {
  return toCents(s) ?? 0;
}
export function milliOrZero(s: string): number {
  return toMilli(s) ?? 0;
}
export function permilleOrZero(s: string): number {
  const p = toPermille(s);
  if (p === null) return 0;
  return Math.max(0, Math.min(1000, p));
}

// ── Einzelpreis (Phase 18f): bis zu 5 Nachkommastellen ─────────────────────────────────────

/** Feldfehler des Preisfelds bei nicht lesbarer/mehrdeutiger Eingabe (leeres Feld ist kein Fehler). */
export const PRICE_FIELD_ERROR = "Preis mehrdeutig oder mehr als 5 Nachkommastellen";

/** Preis-Eingabe ("12,50", "0,002") -> Cent und (nur bei Sub-Cent-Preisen) Milli-Cent, sonst `null`. */
export function toPrice(input: string): { cents: number; milliCents: number | null } | null {
  return parseUnitPriceInput(input);
}

/** Fehlermeldung fuer das Preisfeld oder `null` (leer oder gueltig). */
export function priceFieldError(input: string): string | null {
  if (input.trim() === "") return null;
  return toPrice(input) === null ? PRICE_FIELD_ERROR : null;
}

/** Payload-Felder des Preises; ungueltige/leere Eingabe -> 0 / `null` (wie `centsOrZero`). */
export function priceFieldsOrZero(s: string): { unitNetPriceCents: number; unitNetPriceMilliCents: number | null } {
  const p = toPrice(s);
  return { unitNetPriceCents: p?.cents ?? 0, unitNetPriceMilliCents: p?.milliCents ?? null };
}

/** Anzeige-String des Preisfelds aus gespeicherten Werten ("0,002" bzw. "12,50"). */
export function fromPrice(p: { unitNetPriceCents: number; unitNetPriceMilliCents?: number | null }): string {
  return unitPriceToInput(p);
}

/** Preisfeld normalisieren (Round-Trip): lesbare Eingabe -> kanonische Anzeige, sonst unveraendert. */
export function normalizePriceInput(s: string | undefined): string {
  if (s === undefined || s.trim() === "") return "";
  const p = toPrice(s);
  return p === null ? s : fromPrice({ unitNetPriceCents: p.cents, unitNetPriceMilliCents: p.milliCents });
}
