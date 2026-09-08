/**
 * Prüfung der Rechnungs-Pflichtangaben nach § 14 Abs. 4 / § 14a UStG sowie der
 * schema-spezifischen Pflichthinweise. Rein (keine DB) und damit voll testbar.
 *
 * Quelle: COMPLIANCE.md Abschnitt 1, 3, 8, 9. Diese Prüfung blockt das
 * Festschreiben (finalize), wenn Pflichtangaben fehlen.
 */

import { ZERO_TAX_SCHEMES, EU_COUNTRY_CODES, EU_VAT_PREFIXES } from "@/lib/tax";

export interface MandatoryOrg {
  legalName: string;
  addressLine1: string;
  postalCode: string;
  city: string;
  taxNumber?: string | null;
  vatId?: string | null;
}

export interface MandatoryCustomer {
  name: string;
  addressLine1: string;
  postalCode: string;
  city: string;
  vatId?: string | null;
  countryCode?: string | null;
}

export interface MandatoryLine {
  description: string;
  quantityMilli: number;
  taxRate: number;
  taxCategory: string;
  // Phase 4b (§8) — Fix-Welle K1: HEADING/TEXT/SUBTOTAL sind reine Gliederungszeilen ohne
  // Betrag/Menge und duerfen die Pflichtangaben-Pruefung nicht mit einem
  // "Menge fehlt/0"-Befund blockieren. Fehlt lineType (Alt-Aufrufer), wird ITEM angenommen.
  lineType?: string;
}

export interface MandatoryInvoice {
  type: string; // INVOICE | CREDIT_NOTE | CORRECTION
  taxScheme: string;
  issueDate?: Date | string | null;
  deliveryDate?: Date | string | null;
  deliveryStart?: Date | string | null;
  deliveryEnd?: Date | string | null;
  notes?: string | null;
  isSmallAmount?: boolean; // Kleinbetragsrechnung § 33 UStDV (≤ 250 € brutto)
  lines: readonly MandatoryLine[];
  org: MandatoryOrg;
  customer: MandatoryCustomer;
}

/**
 * Pflichthinweis-Texte je Steuerschema (§ 14 Abs. 4 Nr. 8, § 14a UStG). EINZIGE Quelle
 * im Projekt — src/lib/editor/constants.ts und src/mcp/tools/invoices.ts importieren von
 * hier. Quellen: COMPLIANCE.md § 1 (§ 14a), § 3 (§ 34a UStDV), § 8 (§ 13b/§ 6a), § 9 (§ 25a).
 */
export const SCHEME_NOTICE: Record<string, string> = {
  // § 14a Abs. 5 UStG — wortgleich vorgeschrieben.
  REVERSE_CHARGE: "Steuerschuldnerschaft des Leistungsempfängers",
  // § 3a Abs. 2 UStG (Leistungsort beim Empfaenger) i. V. m. § 14a Abs. 1/5 UStG.
  IG_LEISTUNG: "Steuerschuldnerschaft des Leistungsempfängers",
  IG_LIEFERUNG: "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)",
  AUSFUHR: "Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)",
  // § 34a UStDV (Fassung ab 1.1.2025).
  KLEINUNTERNEHMER: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
  // § 14a Abs. 6 Satz 1 UStG — eine der drei zulaessigen Formulierungen.
  DIFFERENZ: "Gebrauchtgegenstände/Sonderregelung (§ 25a UStG)",
};

/** § 14b Abs. 1 Satz 5 UStG (§ 14 Abs. 4 Nr. 9) — Text fuer PDF UND beide XML-Formate. */
export const CONSUMER_RETENTION_HINT =
  "Sie sind verpflichtet, diese Rechnung zwei Jahre aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).";

/** Vergleichsform: klein, Umlaute/ß gefaltet, Whitespace normalisiert. */
export function normalizeNotice(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Zulaessige Formulierungen je Schema (auf normalizeNotice-Text). Ersetzt die frühere
 * Heuristik "erstes Wort des Pflichttextes kommt irgendwo vor" — die liess z. B.
 * "Steuerfreie Lieferung nach Absprache" als ig. Lieferung durchgehen. § 14a Abs. 6 UStG
 * laesst fuer § 25a genau drei Wortlaute zu.
 */
export const SCHEME_NOTICE_ACCEPTED: Record<string, RegExp[]> = {
  REVERSE_CHARGE: [/steuerschuldnerschaft des leistungsempfaengers/],
  IG_LEISTUNG: [/steuerschuldnerschaft des leistungsempfaengers/],
  IG_LIEFERUNG: [/steuerfreie innergemeinschaftliche lieferung/],
  AUSFUHR: [/steuerfreie ausfuhrlieferung/],
  KLEINUNTERNEHMER: [/kleinunternehmer(?=[\s\S]*\b19\b)/],
  DIFFERENZ: [
    /gebrauchtgegenstaende\s*\/\s*sonderregelung/,
    /kunstgegenstaende\s*\/\s*sonderregelung/,
    /sammlungsstuecke und antiquitaeten\s*\/\s*sonderregelung/,
  ],
};

function hasDeliveryInfo(inv: MandatoryInvoice): boolean {
  return Boolean(inv.deliveryDate || (inv.deliveryStart && inv.deliveryEnd) || inv.notes);
}

/** BR-IC-11: bei ig. Lieferung genuegt der Freitext NICHT — es braucht BT-72 oder BG-14. */
function hasDeliveryDateOrPeriod(inv: MandatoryInvoice): boolean {
  return Boolean(inv.deliveryDate || (inv.deliveryStart && inv.deliveryEnd));
}
/** Zweistelliges USt-IdNr.-Praefix, gross, ohne Leerzeichen. */
function vatPrefix(vatId: string | null | undefined): string {
  return (vatId ?? "").replace(/\s/g, "").slice(0, 2).toUpperCase();
}

/**
 * Liefert eine Liste fehlender/fehlerhafter Pflichtangaben. Leer = ok.
 */
export function validateMandatoryFields(inv: MandatoryInvoice): string[] {
  const problems: string[] = [];
  const { org, customer } = inv;

  // § 14 Abs. 4 Nr. 1 — Aussteller
  if (!org.legalName?.trim()) problems.push("Name des leistenden Unternehmers fehlt (§ 14 Abs. 4 Nr. 1).");
  if (!org.addressLine1?.trim() || !org.postalCode?.trim() || !org.city?.trim())
    problems.push("Vollständige Anschrift des leistenden Unternehmers fehlt (§ 14 Abs. 4 Nr. 1).");

  // § 14 Abs. 4 Nr. 2 — Steuernummer ODER USt-IdNr.
  if (!org.taxNumber?.trim() && !org.vatId?.trim())
    problems.push("Steuernummer oder USt-IdNr. des Ausstellers fehlt (§ 14 Abs. 4 Nr. 2).");

  // Kleinbetragsrechnung (§ 33 UStDV) lässt Empfängerangaben + Leistungszeitpunkt weg.
  const smallAmount = Boolean(inv.isSmallAmount);

  // § 14 Abs. 4 Nr. 1 — Empfänger (nicht bei Kleinbetrag)
  if (!smallAmount) {
    if (!customer.name?.trim()) problems.push("Name des Leistungsempfängers fehlt (§ 14 Abs. 4 Nr. 1).");
    if (!customer.addressLine1?.trim() || !customer.postalCode?.trim() || !customer.city?.trim())
      problems.push("Vollständige Anschrift des Leistungsempfängers fehlt (§ 14 Abs. 4 Nr. 1).");
  }

  // § 14 Abs. 4 Nr. 3 — Ausstellungsdatum
  if (!inv.issueDate) problems.push("Ausstellungsdatum fehlt (§ 14 Abs. 4 Nr. 3).");

  // § 14 Abs. 4 Nr. 5 — Menge/Art der Leistung. Nur ITEM-Zeilen zaehlen als Positionen im
  // Sinne dieser Vorschrift — HEADING/TEXT/SUBTOTAL sind reine Gliederungszeilen ohne
  // Betrag/Menge (§8, kein Menge-0-Workaround) und werden hier uebersprungen.
  const itemLines = inv.lines.filter((l) => (l.lineType ?? "ITEM") === "ITEM");
  if (itemLines.length === 0) problems.push("Mindestens eine Position erforderlich (§ 14 Abs. 4 Nr. 5).");
  itemLines.forEach((line, idx) => {
    if (!line.description?.trim())
      problems.push(`Position ${idx + 1}: Leistungsbeschreibung fehlt (§ 14 Abs. 4 Nr. 5).`);
    if (!Number.isFinite(line.quantityMilli) || line.quantityMilli === 0)
      problems.push(`Position ${idx + 1}: Menge fehlt/0 (§ 14 Abs. 4 Nr. 5).`);
  });

  // § 14 Abs. 4 Nr. 6 — Leistungszeitpunkt (nicht bei Kleinbetrag)
  if (!smallAmount && !hasDeliveryInfo(inv))
    problems.push("Leistungs-/Lieferzeitpunkt fehlt (§ 14 Abs. 4 Nr. 6) — Datum oder Zeitraum oder Hinweis erforderlich.");

  // § 14 Abs. 4 Nr. 8 / § 14a — Steuerausweis oder Befreiungshinweis
  const scheme = inv.taxScheme;
  const noticeRequired = SCHEME_NOTICE[scheme];
  if (noticeRequired) {
    const accepted = SCHEME_NOTICE_ACCEPTED[scheme] ?? [];
    const normalized = normalizeNotice(inv.notes ?? "");
    if (!accepted.some((re) => re.test(normalized))) {
      problems.push(`Pflichthinweis für Schema ${scheme} fehlt im Hinweistext: "${noticeRequired}" (§ 14a UStG / § 14 Abs. 4 Nr. 8).`);
    }
  }
  // Bei steuerbefreiten Schemata darf KEIN USt-Satz > 0 ausgewiesen sein (§ 14c-Risiko).
  if (ZERO_TAX_SCHEMES.has(scheme) && inv.lines.some((l) => l.taxRate > 0)) {
    problems.push(`Schema ${scheme}: Positionen dürfen keinen USt-Satz > 0 ausweisen (§ 14c-Risiko).`);
  }

  // ig. Lieferung/Leistung: USt-IdNr. beider Parteien (§ 14a Abs. 1/3)
  if (scheme === "IG_LIEFERUNG" || scheme === "IG_LEISTUNG") {
    if (!org.vatId?.trim()) problems.push("USt-IdNr. des Ausstellers erforderlich (§ 14a Abs. 1/3).");
    if (!customer.vatId?.trim()) problems.push("USt-IdNr. des Empfängers erforderlich (§ 14a Abs. 1/3).");
  }

  // Phase 12b — materielle Zusatzvoraussetzungen:
  if (scheme === "IG_LIEFERUNG") {
    if (!hasDeliveryDateOrPeriod(inv)) {
      problems.push("Innergemeinschaftliche Lieferung: Leistungsdatum oder Leistungszeitraum erforderlich (§ 14 Abs. 4 Nr. 6; EN 16931 BR-IC-11) — ein Hinweistext genügt hier nicht.");
    }
    const prefix = vatPrefix(customer.vatId);
    if (customer.vatId?.trim() && (prefix === "DE" || !EU_VAT_PREFIXES.has(prefix))) {
      problems.push("USt-IdNr. des Empfängers muss aus einem anderen EU-Mitgliedstaat stammen (§ 6a Abs. 1 Nr. 4 UStG).");
    }
  }
  if (scheme === "REVERSE_CHARGE" && !customer.vatId?.trim()) {
    // BR-AE-3 verlangt BT-48 oder BT-47; BT-47 bildet diese Software nicht ab.
    problems.push("USt-IdNr. des Empfängers erforderlich (§ 13b UStG; EN 16931 BR-AE-3).");
  }
  if (scheme === "AUSFUHR") {
    const country = (customer.countryCode ?? "").toUpperCase();
    if (!country || EU_COUNTRY_CODES.has(country)) {
      problems.push("Ausfuhrlieferung setzt einen Empfänger außerhalb der EU voraus (§ 6 Abs. 1 UStG) — Länderkennzeichen des Kunden prüfen.");
    }
  }

  return problems;
}
