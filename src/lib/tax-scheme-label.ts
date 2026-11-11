const TAX_SCHEME_LABELS: Record<string, string> = {
  REGULAR: "Regelbesteuerung",
  KLEINUNTERNEHMER: "Kleinunternehmer (§ 19)",
  DIFFERENZ: "Differenzbesteuerung (§ 25a)",
  REVERSE_CHARGE: "Reverse Charge (§ 13b)",
  IG_LIEFERUNG: "Innergem. Lieferung (§ 6a)",
  IG_LEISTUNG: "Innergem. Leistung (§ 3a Abs. 2)",
  AUSFUHR: "Ausfuhrlieferung (§ 6)",
  NICHT_STEUERBAR: "Nicht steuerbar, Drittland-Leistung (§ 3a Abs. 2/4/5)",
};

/** Anzeigename eines Steuerschemas (Rohwert nur, wenn unbekannt). */
export function taxSchemeLabel(scheme: string): string {
  return TAX_SCHEME_LABELS[scheme] ?? scheme;
}
