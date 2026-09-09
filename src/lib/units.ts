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

/** Klarname für einen UN/ECE-Einheitencode. Unbekannte Codes kommen unverändert zurück
 *  (z. B. Freitext-Einheiten aus "andere…"), eine leere Eingabe bleibt leer. */
export function unitLabel(code: string): string {
  if (!code) return "";
  return UNIT_LABELS[code] ?? code;
}
