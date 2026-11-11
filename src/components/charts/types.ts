/**
 * Gemeinsame Typen und Farbkonstanten des Inline-SVG-Chart-Baukastens (Phase 12e, Task 1).
 * Die Farben verweisen seit Phase 16f auf die Design-Tokens aus src/app/globals.css.
 */
export interface ChartDatum {
  /** Achsen-/Legendenbeschriftung, z. B. "Mär 26". */
  label: string;
  /** Rohwert (Cent oder Anzahl) — nur fuer die Geometrie. */
  value: number;
  /** Fertig formatiert, z. B. "1.234,56 €" — fuer <title> und sr-only-Wertetabelle. */
  valueLabel: string;
  /** Ueberschreibt die Reihenfarbe (Donut/Status). */
  color?: string;
}

/**
 * Grobe mittlere Zeichenbreite in viewBox-Einheiten je `fontSize`-Einheit (Erfahrungswert
 * fuer Systemschriften) — gemeinsame Konstante fuer `BarChart` (Beschriftungsspalten,
 * waagerecht) und `LineChart` (x-Achsen-Label-Abstand), Fix I6, kein zweiter Naeherungswert.
 */
export const CHAR_WIDTH_FACTOR = 0.6;

export const CHART_COLORS = {
  primary: "var(--color-pen)",
  second: "var(--color-ink-muted)",
  due: "var(--color-seal)",
  overdue: "var(--color-stamp)",
  grid: "var(--color-rule)", // Rasterlinien (dekorativ, keine Text-Kontrastpflicht)
  axis: "var(--color-rule-strong)", // Achsenlinien (dekorativ), NICHT fuer Text
  label: "var(--color-ink-soft)", // Achsen-/Wertebeschriftung (Text, AA)
  centerText: "var(--color-ink)", // DonutChart-Mittelwert
  ledger: "var(--color-ledger)",
} as const;

/** Diagrammschrift in viewBox-Einheiten: fest 12, die Breite kommt per ResponsiveChart in echten Pixeln. */
export const CHART_FONT_SIZE = 12;
