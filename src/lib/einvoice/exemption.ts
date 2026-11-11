/**
 * BT-120 (TaxExemptionReason, Klartext) und BT-121 (TaxExemptionReasonCode, VATEX)
 * je UNTDID-5305-Steuerkategorie — EINZIGE Quelle fuer beide E-Rechnungs-Builder
 * (Phase 12b; vorher stand `exemptionReason` wortgleich in xrechnung.ts und cii.ts).
 *
 * BT-121 nur, wo die amtliche VATEX-Codeliste einen passenden Code kennt. Fuer § 19
 * (Kleinunternehmer, Kategorie E) und den Nullsatz (Z) gibt es keinen; dort erfuellt
 * BT-120 allein BR-E-10/BR-Z-10. Fuer § 25a (Differenzbesteuerung, ebenfalls E)
 * existiert kein EU-Code fuer die Margenbesteuerung von VERKAEUFEN — die VATEX-Codes
 * D/F/I/J betreffen innergemeinschaftliche ERWERBE und passen hier nicht.
 */
import { docStrings } from "@/lib/i18n/doc";
import type { DocLanguage } from "@/lib/i18n/doc/types";

const REASON_CODE: Record<string, string> = {
  AE: "VATEX-EU-AE",
  K: "VATEX-EU-IC",
  G: "VATEX-EU-G",
  O: "VATEX-EU-O",
};

/**
 * Klartext der Steuerbefreiung (BT-120) je Belegsprache; die Texte stehen in
 * src/lib/i18n/doc/{de,en}.ts (`exemptionReason`). Deutsch bleibt der Default, die
 * E-Rechnungs-Builder rufen ohne Sprache auf (Bestandsfixtures unveraendert).
 * Fuer Kategorie S (und unbekannte Kategorien) gibt es keinen Text.
 */
export function exemptionReasonText(category: string, lang: DocLanguage = "de"): string | null {
  const table: Record<string, string> = docStrings(lang).exemptionReason;
  return table[category] ?? null;
}

export function exemptionReasonCode(category: string): string | null {
  return REASON_CODE[category] ?? null;
}

/**
 * EN 16931 Kategorie O (nicht steuerbar): der Beleg traegt mindestens eine Position bzw.
 * Steuergruppe mit "O". BR-O-02 verbietet dann Verkaeufer-USt-IdNr. (BT-31) und Kaeufer-
 * USt-IdNr. (BT-48); BR-O-05..07 verbieten Steuersaetze (BT-152/BT-119).
 */
export function hasNotSubjectToVat(data: {
  lines: readonly { taxCategory: string }[];
  taxSubtotals: readonly { taxCategory: string }[];
}): boolean {
  return data.lines.some((l) => l.taxCategory === "O") || data.taxSubtotals.some((t) => t.taxCategory === "O");
}
