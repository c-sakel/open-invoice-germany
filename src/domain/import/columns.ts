/**
 * Spaltenzuordnung und Zellkonverter fuer den Stammdaten-Import (Phase 18b), rein.
 * Kopfnamen sind Export-Kopf (Phase 18b T2) plus Aliase gaengiger Tabellenkalkulationen.
 * Alle Pruefungen laufen ohne verschachtelte Quantoren (keine ReDoS-Gefahr).
 */
export interface ImportColumn {
  key: string;
  header: string;
  aliases: readonly string[];
  required?: boolean;
}

export const CONTACT_IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: "customerNumber", header: "Kundennummer", aliases: ["Kunden-Nr.", "Kundennr"] },
  { key: "customerType", header: "Typ", aliases: ["Kundentyp", "Kundenart"] },
  { key: "name", header: "Name", aliases: ["Firma", "Firmenname", "Kundenname"], required: true },
  { key: "contactPerson", header: "Ansprechpartner", aliases: ["Kontakt"] },
  { key: "street", header: "Straße", aliases: ["Strasse", "Adresse", "Anschrift", "Adresszeile 1"], required: true },
  { key: "addressExtra", header: "Adresszusatz", aliases: ["Adresszeile 2"] },
  { key: "postalCode", header: "PLZ", aliases: ["Postleitzahl"], required: true },
  { key: "city", header: "Ort", aliases: ["Stadt"], required: true },
  { key: "country", header: "Land", aliases: ["Ländercode", "Country"] },
  { key: "email", header: "E-Mail", aliases: ["Email", "Mail", "E-Mail-Adresse"] },
  { key: "phone", header: "Telefon", aliases: ["Tel", "Telefonnummer"] },
  { key: "vatId", header: "USt-IdNr.", aliases: ["USt-ID", "UStIdNr", "VAT ID"] },
  { key: "leitwegId", header: "Leitweg-ID", aliases: ["Leitweg"] },
  { key: "peppolId", header: "Peppol-ID", aliases: [] },
  { key: "peppolScheme", header: "Peppol-Schema", aliases: [] },
  { key: "registerNumber", header: "Registernummer", aliases: ["Handelsregisternummer"] },
  { key: "paymentTermDays", header: "Zahlungsziel (Tage)", aliases: ["Zahlungsziel"] },
];

export const PRODUCT_IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: "articleNumber", header: "Artikelnummer", aliases: ["Artikel-Nr.", "Artikelnr", "SKU"] },
  { key: "name", header: "Bezeichnung", aliases: ["Name", "Produkt", "Artikel"], required: true },
  { key: "description", header: "Beschreibung", aliases: [] },
  { key: "unit", header: "Einheit", aliases: ["ME"] },
  { key: "netPrice", header: "Nettopreis", aliases: ["Preis netto", "Einzelpreis"], required: true },
  { key: "taxRate", header: "Steuersatz (%)", aliases: ["Steuersatz", "USt-Satz", "MwSt"] },
  { key: "taxCategory", header: "Steuerkategorie", aliases: [] },
  { key: "marginScheme", header: "Differenzbesteuerung", aliases: [] },
  { key: "ossCategory", header: "OSS-Kategorie", aliases: [] },
];

/** trim, lower, ä->ae ö->oe ü->ue ß->ss, nur [a-z0-9]. */
export function normalizeHeader(s: string): string {
  const lower = s.trim().toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch === "ä") out += "ae";
    else if (ch === "ö") out += "oe";
    else if (ch === "ü") out += "ue";
    else if (ch === "ß") out += "ss";
    else if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

export function mapHeader(
  header: readonly string[],
  columns: readonly ImportColumn[],
): { index: Map<string, number>; ignored: string[]; missing: string[]; duplicates: string[] } {
  const byName = new Map<string, string>();
  for (const col of columns) {
    for (const n of [col.header, ...col.aliases]) byName.set(normalizeHeader(n), col.key);
  }
  const index = new Map<string, number>();
  const ignored: string[] = [];
  const duplicates: string[] = [];
  header.forEach((h, i) => {
    const key = byName.get(normalizeHeader(h));
    if (key === undefined) {
      if (h.trim() !== "") ignored.push(h);
      return;
    }
    if (index.has(key)) {
      const label = columns.find((c) => c.key === key)?.header ?? key;
      if (!duplicates.includes(label)) duplicates.push(label);
      return;
    }
    index.set(key, i);
  });
  const missing = columns.filter((c) => c.required && !index.has(c.key)).map((c) => c.header);
  return { index, ignored, missing, duplicates };
}

export function parseCustomerTypeCell(v: string): "BUSINESS" | "CONSUMER" | null {
  const n = normalizeHeader(v);
  if (n === "") return "BUSINESS";
  if (n === "firma" || n === "b2b" || n === "geschaeftskunde" || n === "business") return "BUSINESS";
  if (n === "privat" || n === "b2c" || n === "privatkunde" || n === "consumer") return "CONSUMER";
  return null;
}

export function parseYesNoCell(v: string): boolean | null {
  const n = v.trim().toLowerCase();
  if (n === "") return false;
  if (n === "ja" || n === "x" || n === "1" || n === "true") return true;
  if (n === "nein" || n === "0" || n === "false") return false;
  return null;
}

function isDigits(s: string): boolean {
  if (s === "") return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** "19", "19 %", "7,0" -> Ganzzahl; Nachkommastellen nur als Nullen; sonst null. */
export function parseTaxRateCell(v: string): number | null {
  let t = v.trim();
  if (t.endsWith("%")) t = t.slice(0, -1).trimEnd();
  if (t.length === 0 || t.length > 8) return null;
  let sep = t.indexOf(",");
  if (sep < 0) sep = t.indexOf(".");
  const intPart = sep < 0 ? t : t.slice(0, sep);
  const frac = sep < 0 ? "" : t.slice(sep + 1);
  if (!isDigits(intPart) || intPart.length > 3) return null;
  if (sep >= 0 && (!isDigits(frac) || frac.replace(/0/g, "") !== "")) return null;
  const n = Number(intPart);
  return n >= 0 && n <= 100 ? n : null;
}

export function parseIntCell(v: string, min: number, max: number): number | null {
  const t = v.trim();
  const neg = t.startsWith("-");
  const digits = neg ? t.slice(1) : t;
  if (!isDigits(digits) || digits.length > 9) return null;
  const n = (neg ? -1 : 1) * Number(digits);
  return n >= min && n <= max ? n : null;
}
