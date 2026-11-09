/** Waehrungen, die der Editor zur Auswahl anbietet (ISO 4217). Bestehende Belege mit einem
 *  anderen Code bleiben ueber `currencyOptions` bearbeitbar. */
export const EDITOR_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "DKK", "SEK", "NOK", "PLN", "CZK", "HUF"] as const;

/** Auswahlliste fuer `current`: die Standardliste, ein unbekannter Bestandswert wird angehaengt. */
export function currencyOptions(current: string): string[] {
  const list: string[] = [...EDITOR_CURRENCIES];
  return current && !list.includes(current) ? [...list, current] : list;
}

/** Anzeigesymbol: "€" fuer EUR, sonst der ISO-Code. */
export function currencySymbol(code: string): string {
  return code === "EUR" ? "€" : code;
}
