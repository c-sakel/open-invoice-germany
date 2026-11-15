/**
 * Formatkern DATEV-Export (rein). Fixtures: test/fixtures/datev/*-kopf.utf8.txt sind die Musterdateikoepfe des
 * Formatanbieters (DATEV Developer Portal, DATEV-Format, Musterdaten "Buchungsstapel" und "Debitoren/Kreditoren"):
 * Zeile 1 Kopfzeile, Zeile 2 Spaltenzeile. field-regex.json enthaelt die Ausdruecke je Feld aus der Formatbeschreibung.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { debtorRow } from "@/domain/export/datev/debtor-file";
import { BOOKING_FIELDS, DEBTOR_FIELDS } from "@/domain/export/datev/fields";
import {
  amount,
  belegfeld,
  datevFile,
  dataLine,
  DatevFormatError,
  ddmm,
  ddmmyyyy,
  encodeCp1252,
  unmappableChars,
  headerLine,
  text,
  type CellValue,
  type DatevHeaderInput,
} from "@/domain/export/datev/format";

const dir = path.join(process.cwd(), "test/fixtures/datev");
const stapel = readFileSync(path.join(dir, "EXTF_Buchungsstapel-kopf.utf8.txt"), "utf8").split("\r\n");
const debi = readFileSync(path.join(dir, "EXTF_DebKred_Stamm-kopf.utf8.txt"), "utf8").split("\r\n");
const fieldRegex = JSON.parse(readFileSync(path.join(dir, "field-regex.json"), "utf8")) as {
  BOOKING: Record<string, string>;
  DEBTOR: Record<string, string>;
};

// Header-Ausdruecke #1-#31 aus der Formatbeschreibung (Satzaufbau Version 700); Leerfelder ("^[]$") = leer.
const HEADER_REGEX: readonly (string | null)[] = [
  '^["](EXTF|DTVF)["]$',
  "^(700)$",
  "^(16|20|21|46|48|65)$",
  '^["](Buchungsstapel|Wiederkehrende Buchungen|Debitoren/Kreditoren|Kontenbeschriftungen|Zahlungsbedingungen|Diverse Adressen)["]$',
  "^(2|4|5|13)$",
  "^([2])([0])([0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])(2[0-3]|[01][0-9])([0-5][0-9])([0-5][0-9][0-9][0-9][0-9])$",
  null,
  '^["]\\w{0,2}["]$',
  '^["]\\w{0,25}["]$',
  '^["]\\w{0,25}["]$',
  "^(\\d{4,6}|\\d{7})$",
  "^\\d{1,5}$",
  "^([2])([0])([0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])$",
  "^[4-8]$",
  "^([2])([0])([0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])$",
  "^([2])([0])([0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])$",
  '^["][\\w.-/ ]{0,30}["]$',
  '^["]([A-Z]{2}){0,2}["]$',
  "^[1-2]$",
  "^(0|30|40|50|64)$",
  "^(0|1)$",
  '^["]([A-Z]{3})["]$',
  null,
  '^["]["]$',
  null,
  null,
  '^["](\\d{2}){0,2}["]$',
  "^\\d{0,4}$",
  null,
  '^["]["]$',
  '^["].{0,16}["]$',
];

const stapelHeader: DatevHeaderInput = {
  category: 21,
  createdAt: new Date("2024-01-30T13:04:40.439Z"), // 14:04:40,439 Berliner Zeit (UTC+1)
  consultantNumber: 29098,
  clientNumber: 55003,
  fiscalYearStart: new Date(Date.UTC(2024, 0, 1)),
  accountLength: 4,
  periodFrom: new Date(Date.UTC(2024, 0, 1)),
  periodTo: new Date(Date.UTC(2024, 7, 31)),
  label: "Buchungsstapel",
  dictationCode: "WD",
  lockBatch: false,
  chart: "SKR03",
};

/** `bewegungsdaten` false: Stammdaten lassen Felder 15-26 leer (Musterdatei), dort keine Ausdruckspruefung. */
function expectHeaderMatches(line: string, bewegungsdaten = true): void {
  const cells = line.split(";");
  expect(cells).toHaveLength(31);
  cells.forEach((cell, i) => {
    const re = HEADER_REGEX[i];
    if (!bewegungsdaten && i >= 14 && i <= 25) return;
    if (re === null) expect(cell, `Header #${i + 1}`).toBe("");
    else expect(new RegExp(re).test(cell), `Header #${i + 1}: ${cell}`).toBe(true);
  });
}

describe("Feldlisten", () => {
  it("Anzahl und Spaltenzeile byte-gleich mit den Musterdateien", () => {
    expect(BOOKING_FIELDS).toHaveLength(125);
    expect(DEBTOR_FIELDS).toHaveLength(254);
    expect(BOOKING_FIELDS.map((f) => f.no)).toEqual(Array.from({ length: 125 }, (_, i) => i + 1));
    const b = datevFile("H", BOOKING_FIELDS, []).toString("latin1").split("\r\n");
    expect(b[1]).toBe(encodeCp1252(stapel[1]).toString("latin1"));
    const d = datevFile("H", DEBTOR_FIELDS, []).toString("latin1").split("\r\n");
    expect(d[1]).toBe(encodeCp1252(debi[1]).toString("latin1"));
    expect(stapel[1].split(";")).toHaveLength(125);
    expect(debi[1].split(";")).toHaveLength(254);
  });

  it("Art folgt dem Ausdruck (Text mit Anfuehrungszeichen)", () => {
    const kind = (no: number) => BOOKING_FIELDS[no - 1].kind;
    for (const no of [2, 3, 6, 9, 11, 12, 14, 20, 21, 118]) expect(kind(no), `Feld ${no}`).toBe("text");
    for (const no of [1, 7, 8, 10, 13, 17, 114, 125]) expect(kind(no), `Feld ${no}`).toBe("num");
    for (const f of BOOKING_FIELDS) {
      const re = fieldRegex.BOOKING[String(f.no)];
      expect(/^\^\(?\[?"/.test(re), `Buchungsstapel ${f.no}`).toBe(f.kind === "text");
    }
    for (const f of DEBTOR_FIELDS) {
      const re = fieldRegex.DEBTOR[String(f.no)];
      expect(/^\^?\(?"/.test(re), `Debitoren ${f.no}`).toBe(f.kind === "text");
    }
  });
});

describe("headerLine", () => {
  it("entspricht der Musterkopfzeile des Buchungsstapels", () => {
    expect(headerLine(stapelHeader)).toBe(stapel[0]);
  });

  it("Debitoren-Kopf entspricht der Musterkopfzeile", () => {
    const line = headerLine({ ...stapelHeader, category: 16, createdAt: new Date("2024-01-30T13:06:59.583Z"), lockBatch: false });
    expect(line).toBe(debi[0]);
  });

  it("alle 31 Felder gegen die Header-Ausdruecke", () => {
    expectHeaderMatches(headerLine(stapelHeader));
    expectHeaderMatches(headerLine({ ...stapelHeader, lockBatch: true, dictationCode: null, chart: "SKR04", accountLength: 8, label: "Rechnungen 2024/01" }));
    expectHeaderMatches(headerLine({ ...stapelHeader, category: 16 }), false);
  });

  it("Festschreibung ausdruecklich, Zeitstempel in Berliner Sommerzeit", () => {
    const line = headerLine({ ...stapelHeader, lockBatch: true, createdAt: new Date("2024-07-01T10:00:00.005Z") });
    const cells = line.split(";");
    expect(cells[20]).toBe("1");
    expect(cells[5]).toBe("20240701120000005");
  });

  it("Bezeichnung wird auf erlaubte Zeichen und 30 Stellen begrenzt", () => {
    const cells = headerLine({ ...stapelHeader, label: 'Rechnungen "Q1"; Zeile\n2 mit sehr vielen Zeichen darin' }).split(";");
    expect(cells[16]).toBe('"Rechnungen _Q1__ Zeile 2 mit s"');
  });

  it("lehnt ungueltige Werte ab", () => {
    expect(() => headerLine({ ...stapelHeader, fiscalYearStart: new Date(Date.UTC(2100, 0, 1)) })).toThrow("DATEV-Format erlaubt nur Jahre 2000 bis 2099");
    expect(() => headerLine({ ...stapelHeader, periodTo: new Date(Date.UTC(1999, 11, 31)), periodFrom: new Date(Date.UTC(1999, 0, 1)) })).toThrow(DatevFormatError);
    expect(() => headerLine({ ...stapelHeader, consultantNumber: 999 })).toThrow(DatevFormatError);
    expect(() => headerLine({ ...stapelHeader, clientNumber: 100000 })).toThrow(DatevFormatError);
    expect(() => headerLine({ ...stapelHeader, accountLength: 9 })).toThrow(DatevFormatError);
    expect(() => headerLine({ ...stapelHeader, dictationCode: "wd" })).toThrow(DatevFormatError);
    expect(() => headerLine({ ...stapelHeader, periodFrom: undefined })).toThrow(DatevFormatError);
    expect(() => headerLine({ ...stapelHeader, createdAt: new Date("2100-01-01T12:00:00Z") })).toThrow(DatevFormatError);
  });
});

describe("dataLine", () => {
  const row: Record<number, CellValue> = {
    1: amount(123456),
    2: "S",
    3: "EUR",
    7: 10000,
    8: 8400,
    9: "0003",
    10: ddmm(new Date(Date.UTC(2096, 2, 5))),
    11: belegfeld("RE-2096/17"),
    12: belegfeld("AR 1"),
    13: "12,34",
    14: text("Rechnung \"Müller\"; Lieferung", 60),
    17: 123,
    20: "https://example.invalid/b",
    21: "Beleg",
    22: "a".repeat(210),
    104: ddmmyyyy(new Date(Date.UTC(2096, 2, 5))),
    111: "05032096",
    114: 0,
    118: "0",
    125: 1234,
  };
  const map = new Map<number, CellValue>(Object.entries(row).map(([k, v]) => [Number(k), v]));

  it("jede belegte Zelle passt zum Ausdruck des Feldes (Stapel)", () => {
    for (const no of Object.keys(row).map(Number)) {
      const cell = cellAt(BOOKING_FIELDS, map, no);
      expect(new RegExp(fieldRegex.BOOKING[String(no)]).test(cell), `Feld ${no}: ${cell}`).toBe(true);
    }
  });

  it("Zellformat: Text verdoppelt Anfuehrungszeichen, leer ist \"\" bzw. nichts", () => {
    const line = dataLine(BOOKING_FIELDS, new Map<number, CellValue>([[14, 'a"b;c']]));
    expect(line).toContain('"a""b;c"');
    expect(dataLine([{ kind: "num" }, { kind: "text" }, { kind: "num" }], new Map())).toBe(';"";');
  });

  it("Debitorenzeile Stapel gegen Ausdruecke", () => {
    const m = new Map<number, CellValue>([[1, 10001], [2, "Muster GmbH"], [7, "2"], [9, "DE"], [16, "Musterweg 1"], [20, "DE"]]);
    for (const [no] of m) {
      const cell = cellAt(DEBTOR_FIELDS, m, no);
      expect(new RegExp(fieldRegex.DEBTOR[String(no)]).test(cell), `Debitor ${no}: ${cell}`).toBe(true);
    }
    expect(dataLine(DEBTOR_FIELDS, m).split(";")).toHaveLength(254);
  });

  it("lehnt Zeilenumbrueche, Strukturzeichen in Zahlzellen und unbekannte Felder ab", () => {
    expect(() => dataLine(BOOKING_FIELDS, new Map([[14, "a\nb"]]))).toThrow(DatevFormatError);
    expect(() => dataLine(BOOKING_FIELDS, new Map([[7, "1;2"]]))).toThrow(DatevFormatError);
    expect(() => dataLine(BOOKING_FIELDS, new Map([[126, "x"]]))).toThrow(DatevFormatError);
  });
});

/** Zelle `no` einer Zeile: je Feld einzeln gebaut, damit Semikolons in Text die Spalten nicht verschieben. */
function cellAt(fields: typeof BOOKING_FIELDS, values: ReadonlyMap<number, CellValue>, no: number): string {
  return dataLine([fields[no - 1]], new Map([[1, values.get(no) as CellValue]]));
}

describe("Zellenregeln", () => {
  it("amount", () => {
    expect(amount(1)).toBe("0,01");
    expect(amount(100)).toBe("1,00");
    expect(amount(123456789012)).toBe("1234567890,12");
    expect(amount(999_999_999_999)).toBe("9999999999,99");
    expect(() => amount(0)).toThrow(DatevFormatError);
    expect(() => amount(-5)).toThrow(DatevFormatError);
    expect(() => amount(1_000_000_000_000)).toThrow(DatevFormatError);
    expect(() => amount(1.5)).toThrow(DatevFormatError);
    expect(() => amount(Number.NaN)).toThrow(DatevFormatError);
  });

  it("Datum: Berliner Kalendertag, Jahre 2000 bis 2099", () => {
    // 2096-03-05 23:30 UTC ist in Berlin bereits der 06.03.
    expect(ddmm(new Date(Date.UTC(2096, 2, 5, 23, 30)))).toBe("0603");
    expect(ddmmyyyy(new Date(Date.UTC(2096, 2, 5, 12)))).toBe("05032096");
    expect(() => ddmm(new Date(Date.UTC(2100, 0, 1, 12)))).toThrow("DATEV-Format erlaubt nur Jahre 2000 bis 2099");
    expect(() => ddmmyyyy(new Date(Date.UTC(1999, 0, 1, 12)))).toThrow(DatevFormatError);
  });

  it("belegfeld", () => {
    expect(belegfeld("RE 2026.17/ä")).toBe("RE_2026_17/_");
    expect(belegfeld("A$&%*+-/_9")).toBe("A$&%*+-/_9");
    expect(belegfeld("x".repeat(40))).toHaveLength(36);
    expect(belegfeld("😀")).toBe("_");
  });

  it("text", () => {
    expect(text('  a"b;c\r\nd\te  ', 50)).toBe('a"b;c  d e');
    expect(text("abcdef", 3)).toBe("abc");
    expect(text("ab \n", 3)).toBe("ab");
  });

  it("text: Formelzeichen am Anfang bekommen einen Apostroph, auch nach Leerraum, nie doppelt", () => {
    expect(text('=HYPERLINK("http://x";"y")', 80)).toBe('\'=HYPERLINK("http://x";"y")');
    expect(text("\t+1234", 20)).toBe("'+1234");
    expect(text("  @SUMME(A1)", 20)).toBe("'@SUMME(A1)");
    expect(text("-5 Rabatt", 20)).toBe("'-5 Rabatt");
    expect(text(text("=1+1", 20), 20)).toBe("'=1+1");
    expect(text("Muster = GmbH", 20)).toBe("Muster = GmbH");
  });
});

describe("Debitorenzeile", () => {
  it("Kundenname mit Formel: Apostroph in der Zelle, Protokollnotiz", () => {
    const r = debtorRow(
      { id: "c", type: "BUSINESS", name: '=HYPERLINK("http://x";"y")', customerNumber: "K-1", vatId: null, addressLine1: "Weg 1", addressLine2: null, postalCode: "12345", city: "Stadt", countryCode: "DE" },
      10001,
    );
    expect(r.line).toContain('"\'=HYPERLINK(""http://x"";""y"")"');
    expect(r.notes.some((n) => /Formelzeichen/.test(n))).toBe(true);
  });
});

describe("Windows-1252 und Datei", () => {
  it("Umlaute, Gedankenstrich, Euro, Emoji", () => {
    const b = encodeCp1252("Müller & Söhne – Straße");
    expect(b[1]).toBe(0xfc);
    expect(b.indexOf(0x96)).toBeGreaterThan(0);
    expect(b.indexOf(0xdf)).toBeGreaterThan(0);
    expect(encodeCp1252("5 €").toString("latin1")).toBe("5 EUR");
    expect(encodeCp1252("a😀b").toString("latin1")).toBe("a?b");
    expect(encodeCp1252("Łukasz Žďár‑Říčany").equals(Buffer.from([0x4c,0x75,0x6b,0x61,0x73,0x7a,0x20,0x8e,0x64,0xe1,0x72,0x2d,0x52,0xed,0x63,0x61,0x6e,0x79]))).toBe(true);
    expect(unmappableChars("Łódź Мир 😀")).toEqual(["М", "и", "р", "😀"]);
    expect(encodeCp1252("„x“").equals(Buffer.from([0x84, 0x78, 0x93]))).toBe(true);
  });

  it("jede Zeile endet auf CRLF, keine BOM, Header zuerst", () => {
    const buf = datevFile(headerLine(stapelHeader), BOOKING_FIELDS, [new Map<number, CellValue>([[1, "1,00"], [14, "Müller"]])]);
    expect(buf[0]).not.toBe(0xef);
    expect(buf[0]).toBe(0x22);
    const s = buf.toString("latin1");
    expect(s.endsWith("\r\n")).toBe(true);
    const lines = s.split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(s.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe(stapel[0]);
    expect(lines[2]).toContain('"M\xfcller"');
    expect(lines[2].split(";").length).toBeGreaterThanOrEqual(125);
  });
});
