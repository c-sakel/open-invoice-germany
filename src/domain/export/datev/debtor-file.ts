/**
 * Debitorenstammdaten im DATEV-Format (Kategorie 16): je gebuchtem Personenkonto ein Satz.
 * Nur Konto, Name, Adressatentyp, Kurzbezeichnung, USt-IdNr., Anschrift — keine E-Mail, kein Telefon, keine
 * Bankverbindung. Nicht darstellbare Werte bleiben leer bzw. werden gekuerzt und als Hinweis gemeldet.
 */
import { normalizeVatId, vatIdFormatProblem } from "@/lib/vat-id";
import { DEBTOR_FIELDS } from "./fields";
import { dataLine, startsWithFormula, text, unmappableChars, type CellValue } from "./format";

export interface DebtorCustomer {
  id: string;
  type: string;
  name: string;
  customerNumber: string | null;
  vatId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}

export interface DebtorRow {
  account: number;
  line: string;
  notes: string[];
}

function fit(value: string, max: number, label: string, notes: string[]): string {
  if (startsWithFormula(value)) notes.push(`${label} beginnt mit einem Formelzeichen, Apostroph vorangestellt`);
  const cleaned = text(value, Number.MAX_SAFE_INTEGER);
  if (Array.from(cleaned).length > max) notes.push(`${label} auf ${max} Zeichen gekuerzt`);
  const lost = unmappableChars(value);
  if (lost.length > 0) notes.push(`${label} enthaelt Zeichen ausserhalb Windows-1252 (${lost.join(" ")}), als ? ausgegeben`);
  return text(cleaned, max);
}

export function debtorRow(c: DebtorCustomer, account: number): DebtorRow {
  const notes: string[] = [];
  const cells = new Map<number, CellValue>();
  cells.set(1, account);
  if (c.name.trim() === "") notes.push("Name leer");
  const name = fit(c.name, 50, "Name", notes);
  if (c.type === "CONSUMER") {
    cells.set(6, name);
    cells.set(7, "0");
  } else {
    cells.set(2, name);
    cells.set(7, "2");
  }
  if (c.customerNumber) cells.set(8, fit(c.customerNumber, 15, "Kurzbezeichnung", notes));
  const vat = normalizeVatId(c.vatId ?? "");
  const m = /^([A-Z]{2})(.+)$/.exec(vat);
  if (m) {
    // Wie im Buchungsstapel: nur geprueftes EU-Format; Drittland-Nummern bleiben leer.
    const problem = vatIdFormatProblem(vat);
    if (problem) notes.push(`USt-IdNr. nicht uebernommen (${problem})`);
    else {
      cells.set(9, m[1]);
      cells.set(10, fit(m[2], 13, "USt-IdNr.", notes));
    }
  } else if (vat !== "") {
    notes.push("USt-IdNr. ohne Laenderkuerzel nicht uebernommen");
  }
  cells.set(15, "STR");
  cells.set(16, fit(c.addressLine1, 36, "Strasse", notes));
  const digits = c.postalCode.replace(/\s+/g, "");
  if (/^\d{1,10}$/.test(digits)) cells.set(18, digits);
  else if (digits !== "") notes.push(`Postleitzahl "${text(c.postalCode, 12)}" nicht numerisch, leer gelassen`);
  cells.set(19, fit(c.city, 30, "Ort", notes));
  if (c.countryCode !== "DE" && /^[A-Z]{2}$/.test(c.countryCode)) cells.set(20, c.countryCode);
  if (c.addressLine2) cells.set(22, fit(c.addressLine2, 36, "Adresszusatz", notes));
  return { account, line: dataLine(DEBTOR_FIELDS, cells), notes };
}
