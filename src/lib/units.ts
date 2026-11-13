import type { DocLanguage } from "@/lib/i18n/doc/types";

/**
 * Klarnamen für UN/ECE-Rec.20-Einheitencodes (Menge-Spalte in PDF/UI). Der Code selbst
 * bleibt überall unverändert gespeichert/übertragen — er ist Pflichtangabe für BT-130
 * (XRechnung/ZUGFeRD) und ändert sich hier nicht; `unitLabel` ist eine reine
 * Anzeige-Funktion für Menschen.
 *
 * Bewusst KEIN direkter Re-Export von `UNIT_OPTIONS` (`@/lib/editor/constants`): jene
 * Liste ist auf die Editor-Auswahl zugeschnitten (z. B. "Stunde"/"Stück-Pauschale" als
 * ausführlichere Option-Labels), hier sind kompakte Kürzel gefragt, die in einer engen
 * Tabellenspalte neben der Zahl stehen ("Stk"/"Std"/"Pauschale"). Beide Listen tragen
 * dieselben Codes — Codes/Reihenfolge stammen aus `UNIT_OPTIONS`, nur die Anzeigeform
 * unterscheidet sich je Verwendungszweck (Lastenheft 1.4/61.5: kein zweites, abweichendes
 * Vokabular an Codes, nur eine zweite Beschriftung).
 */
const UNIT_LABELS: Record<string, string> = {
  C62: "Stk",
  HUR: "Std",
  DAY: "Tag",
  KGM: "kg",
  MTR: "m",
  LTR: "l",
  MTK: "m²",
  H87: "Pauschale",
};

/** Englische Kürzel (Belegsprache en) — gleiche Codes, nur andere Anzeigeform. */
const UNIT_LABELS_EN: Record<string, string> = {
  C62: "pcs",
  HUR: "h",
  DAY: "day",
  KGM: "kg",
  MTR: "m",
  LTR: "l",
  MTK: "m²",
  H87: "flat rate",
};

/** Klarname für einen UN/ECE-Einheitencode. Unbekannte Codes kommen unverändert zurück
 *  (z. B. Freitext-Einheiten aus "andere…"), eine leere Eingabe bleibt leer. */
export function unitLabel(code: string, lang: DocLanguage = "de"): string {
  if (!code) return "";
  return (lang === "en" ? UNIT_LABELS_EN : UNIT_LABELS)[code] ?? code;
}

const UNIT_CODES: ReadonlySet<string> = new Set(["C62", "HUR", "DAY", "KGM", "MTR", "LTR", "MTK", "H87"]);

const UNIT_INPUT_ALIASES: Readonly<Record<string, string>> = {
  stk: "C62", "stk.": "C62", stueck: "C62", "stück": "C62", st: "C62", pcs: "C62",
  std: "HUR", "std.": "HUR", stunde: "HUR", stunden: "HUR", h: "HUR",
  tag: "DAY", tage: "DAY", d: "DAY",
  kg: "KGM", m: "MTR", l: "LTR", liter: "LTR",
  "m²": "MTK", m2: "MTK", qm: "MTK",
  pauschale: "H87", psch: "H87", "psch.": "H87", "stück-pauschale": "H87",
};

/** Import-Eingabe (Kürzel/Langform/Code) -> UN/ECE-Code. Unbekannter Freitext bleibt
 *  unverändert (wie im Editor "andere…"), leer -> "C62". */
export function unitCodeFromInput(input: string): string {
  const t = input.trim();
  if (!t) return "C62";
  const upper = t.toUpperCase();
  if (UNIT_CODES.has(upper) && t === upper) return upper;
  return UNIT_INPUT_ALIASES[t.toLowerCase()] ?? t;
}
