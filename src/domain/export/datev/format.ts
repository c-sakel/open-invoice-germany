/**
 * Reiner Formatkern fuer Dateien im DATEV-Format (EXTF): Kopfzeile, Spaltenzeile, Datenzeilen, Zellenregeln.
 *
 * Quelle: DATEV Developer Portal, DATEV-Format (Header-Satzaufbau Version 700, Buchungsstapel Version 13,
 * Debitoren/Kreditoren Version 5). Aufbau der Kopfzeile und Beispielwerte stehen in
 * test/fixtures/datev/*-kopf.utf8.txt (Zeile 1). Datei: Windows-1252, Semikolon, CRLF je Zeile, ohne BOM.
 * Keine Datenbank, kein Netz.
 */
import { berlinParts } from "@/lib/berlin-time";
import { FORMULA_START } from "@/domain/export/csv-writer";
import { encodeCp1252, unmappableChars } from "./cp1252";
import type { DatevField, FieldKind } from "./fields";

export { encodeCp1252, unmappableChars };

export class DatevFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatevFormatError";
  }
}

/** Hoechstbetrag: Ausdruck Feld 1 erlaubt 10 Vorkomma- und 2 Nachkommastellen. */
const MAX_CENTS = 999_999_999_999;

/** Feld 1 (Umsatz): positiv, nicht 0,00, `\d{1,10},\d{2}`; Cent als ganze Zahl, nie Float. */
export function amount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new DatevFormatError("DATEV-Betrag muss eine ganze Zahl in Cent sein");
  if (cents <= 0) throw new DatevFormatError("DATEV-Betrag muss positiv sein (nicht 0,00)");
  if (cents > MAX_CENTS) throw new DatevFormatError("DATEV-Betrag ueberschreitet 9999999999,99");
  const euro = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${euro},${String(rest).padStart(2, "0")}`;
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

/** Header-Ausdruecke (Felder 6, 13, 15, 16) und Feld 10 verlangen Jahre 20xx. */
function checkYear(year: number): void {
  if (year < 2000 || year > 2099) throw new DatevFormatError("DATEV-Format erlaubt nur Jahre 2000 bis 2099");
}

/** Berliner Kalendertag als `YYYYMMDD` (Header-Felder 13, 15, 16). */
function yyyymmdd(day: Date): string {
  const p = berlinParts(day);
  checkYear(p.year);
  return `${pad(p.year, 4)}${pad(p.month, 2)}${pad(p.day, 2)}`;
}

/** Feld 10 (Belegdatum): `TTMM`; das Jahr kommt aus dem Header (Feld 13). */
export function ddmm(day: Date): string {
  const p = berlinParts(day);
  checkYear(p.year);
  return `${pad(p.day, 2)}${pad(p.month, 2)}`;
}

/** Datumsfelder mit Jahr (z. B. Buchungsstapel Feld 104/111): `TTMMJJJJ`. */
export function ddmmyyyy(day: Date): string {
  const p = berlinParts(day);
  checkYear(p.year);
  return `${pad(p.day, 2)}${pad(p.month, 2)}${pad(p.year, 4)}`;
}

/**
 * Feld 11/12 (Belegfeld): erlaubt `[\w$&%*+\-/]{0,36}` — Leerzeichen, Umlaute, Punkt, Komma, Semikolon, Doppelpunkt
 * sind unzulaessig. Andere Zeichen werden je Zeichen zu "_", dann auf 36 gekuerzt.
 */
export function belegfeld(s: string): string {
  return Array.from(s)
    .map((c) => (/^[A-Za-z0-9_$&%*+\-/]$/.test(c) ? c : "_"))
    .slice(0, 36)
    .join("");
}

function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

/** Wuerde `text` einen Apostroph voranstellen (Formelzeichen am Anfang, gleiche Regel wie der CSV-Schreiber)? */
export function startsWithFormula(s: string): boolean {
  return FORMULA_START.test(cleanText(s));
}

/**
 * Freitext: Steuerzeichen (inkl. CR, LF, Tab) zu Leerzeichen, trimmen, auf `max` Zeichen kuerzen.
 * Beginnt der Text mit einem Formelzeichen (= + - @, auch nach Leerraum), steht ein Apostroph davor
 * (Schutz vor Formel-Injection beim Oeffnen in Tabellenkalkulationen); bereits gekuerzte Werte bleiben stabil.
 */
export function text(s: string, max: number): string {
  const cleaned = cleanText(s);
  const guarded = startsWithFormula(cleaned) ? `'${cleaned}` : cleaned;
  return Array.from(guarded).slice(0, max).join("").trim();
}

export type CellValue = string | number;

function textCell(v: CellValue | undefined): string {
  const s = v === undefined ? "" : String(v);
  if (/[\r\n]/.test(s)) throw new DatevFormatError("DATEV-Textzelle darf keine Zeilenumbrueche enthalten");
  return `"${s.replace(/"/g, '""')}"`;
}

function numCell(v: CellValue | undefined): string {
  if (v === undefined) return "";
  const s = String(v);
  if (/[;"\r\n]/.test(s)) throw new DatevFormatError("DATEV-Zahlzelle enthaelt unzulaessige Zeichen");
  return s;
}

/** Datenzeile (ohne Zeilenende): Textzellen in Anfuehrungszeichen (`"` verdoppelt), Zahlzellen unquotiert, leer = nichts. */
export function dataLine(fields: readonly { kind: FieldKind }[], values: ReadonlyMap<number, CellValue>): string {
  for (const no of values.keys()) {
    if (!Number.isInteger(no) || no < 1 || no > fields.length) throw new DatevFormatError(`Unbekanntes DATEV-Feld ${no}`);
  }
  return fields.map((f, i) => (f.kind === "text" ? textCell(values.get(i + 1)) : numCell(values.get(i + 1)))).join(";");
}

/** Gesamte Datei: Kopfzeile, Spaltenzeile (Feldnamen), Datenzeilen; Windows-1252, CRLF je Zeile, ohne BOM. */
export function datevFile(
  header: string,
  fields: readonly DatevField[],
  rows: readonly ReadonlyMap<number, CellValue>[],
): Buffer {
  const lines = [header, fields.map((f) => f.name).join(";"), ...rows.map((r) => dataLine(fields, r))];
  return encodeCp1252(lines.map((l) => `${l}\r\n`).join(""));
}

export interface DatevHeaderInput {
  /** 21 = Buchungsstapel (Version 13), 16 = Debitoren/Kreditoren (Version 5). */
  category: 21 | 16;
  createdAt: Date;
  consultantNumber: number;
  clientNumber: number;
  fiscalYearStart: Date;
  accountLength: number;
  periodFrom?: Date;
  periodTo?: Date;
  label?: string;
  dictationCode: string | null;
  lockBatch: boolean;
  chart: "SKR03" | "SKR04";
}

const berlinClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Feld 6: Zeitstempel `YYYYMMDDHHMMSSFFF` in Berliner Zeit. */
function timestamp(d: Date): string {
  const p = berlinParts(d);
  checkYear(p.year);
  const clock: Record<string, string> = {};
  for (const part of berlinClock.formatToParts(d)) clock[part.type] = part.value;
  const ms = ((d.getTime() % 1000) + 1000) % 1000;
  return `${pad(p.year, 4)}${pad(p.month, 2)}${pad(p.day, 2)}${clock.hour}${clock.minute}${clock.second}${pad(ms, 3)}`;
}

function intInRange(v: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(v) || v < min || v > max) throw new DatevFormatError(`${what} muss zwischen ${min} und ${max} liegen`);
  return v;
}

/**
 * Kopfzeile mit 31 Feldern (Version 700). Stapel: Buchungstyp 1 (Finanzbuchfuehrung), Rechnungslegungszweck 0,
 * Festschreibung ausdruecklich 0 oder 1, WKZ "EUR". Debitoren: Felder 15-21 und 23-26 leer, Felder 17/18/22/24
 * als leere Textzellen (Aufbau wie Musterdatei).
 */
export function headerLine(h: DatevHeaderInput): string {
  const consultant = intInRange(h.consultantNumber, 1001, 9_999_999, "Beraternummer");
  const client = intInRange(h.clientNumber, 1, 99_999, "Mandantennummer");
  const accountLength = intInRange(h.accountLength, 4, 8, "Sachkontenlaenge");
  if (!/^([A-Z]{2}){0,2}$/.test(h.dictationCode ?? "")) throw new DatevFormatError("Diktatkuerzel muss aus 0 bis 2 Paaren Grossbuchstaben bestehen");
  const chart = h.chart === "SKR03" ? "03" : "04";
  const common = [
    '"EXTF"',
    "700",
    String(h.category),
    h.category === 21 ? '"Buchungsstapel"' : '"Debitoren/Kreditoren"',
    h.category === 21 ? "13" : "5",
    timestamp(h.createdAt),
    "", // 7 Importiert (Leerfeld)
    '"RE"', // 8 Herkunft
    '""', // 9 Exportiert von
    '""', // 10 Importiert von
    String(consultant),
    String(client),
    yyyymmdd(h.fiscalYearStart),
    String(accountLength),
  ];
  let middle: string[];
  if (h.category === 21) {
    if (!h.periodFrom || !h.periodTo) throw new DatevFormatError("Buchungsstapel braucht Datum von und bis");
    const from = yyyymmdd(h.periodFrom);
    const to = yyyymmdd(h.periodTo);
    if (to < from) throw new DatevFormatError("Datum bis liegt vor Datum von");
    // Bezeichnung: Ausdruck [\w.-/ ]{0,30} -> erlaubt sind Wortzeichen, Punkt, Schraegstrich, Leerzeichen.
    const label = Array.from(text(h.label ?? "", 30)).map((c) => (/^[A-Za-z0-9_./ ]$/.test(c) ? c : "_")).join("");
    middle = [
      from, // 15
      to, // 16
      `"${label}"`, // 17
      `"${h.dictationCode ?? ""}"`, // 18
      "1", // 19 Buchungstyp Finanzbuchfuehrung
      "0", // 20 Rechnungslegungszweck unabhaengig
      h.lockBatch ? "1" : "0", // 21 Festschreibung
      '"EUR"', // 22
      "", // 23
      '""', // 24
      "", // 25
      "", // 26
    ];
  } else {
    middle = ["", "", '""', '""', "", "", "", '""', "", '""', "", ""];
  }
  const tail = [`"${chart}"`, "", "", '""', '""']; // 27 Sachkontenrahmen, 28, 29, 30, 31
  return [...common, ...middle, ...tail].join(";");
}
