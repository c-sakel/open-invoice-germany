import { createHash } from "node:crypto";

/**
 * CSV-Parser fuer den Stammdaten-Import (Phase 18b).
 *
 * Quellen: RFC 4180 (Quoting, "" als maskiertes Anfuehrungszeichen) und OWASP
 * "CSV Injection" (Formelschutz beim Rueckweg liegt im Aufrufer: Zellwerte bleiben hier
 * unveraendert, nur Text).
 *
 * Sicherheit: Groessen-, Zeilen-, Spalten- und Zellgrenze werden frueh geprueft; der Parser
 * ist ein einziger zeichenweiser Zustandsautomat (kein Regex ueber den Gesamttext, damit
 * kein ReDoS) und bricht bei der 2.001. Datenzeile ab, ohne den Rest zu lesen.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2_000;
export const MAX_IMPORT_COLUMNS = 60;
export const MAX_CELL_CHARS = 5_000;

export class CsvLimitError extends Error {
  readonly status = 413;
  constructor(message: string) {
    super(message);
    this.name = "CsvLimitError";
  }
}

export class CsvFormatError extends Error {
  readonly status = 400;
  constructor(message: string, readonly line?: number) {
    super(message);
    this.name = "CsvFormatError";
  }
}

function tooLarge(): CsvLimitError {
  return new CsvLimitError("Datei zu groß (höchstens 2 MB).");
}

/** Bytes -> Text. Groesse zuerst (ohne Dekodieren), UTF-16-BOM abgelehnt, UTF-8 strikt,
 *  sonst Windows-1252; ein UTF-8-BOM wird entfernt. */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: "utf-8" | "windows-1252" } {
  if (bytes.length > MAX_IMPORT_BYTES) throw tooLarge();
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw new CsvFormatError("UTF-16 wird nicht unterstützt — bitte als UTF-8 oder Windows-1252 speichern.");
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bytes.subarray(start);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, encoding: "utf-8" };
  } catch {
    const text = new TextDecoder("windows-1252").decode(body);
    return { text, encoding: "windows-1252" };
  }
}

export interface ParsedCsv {
  delimiter: ";" | ",";
  header: string[];
  /** line = physische Startzeile (Kopf = 1) */
  rows: { line: number; cells: string[] }[];
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

function detectDelimiter(text: string, start: number): ";" | "," {
  let semi = 0;
  let comma = 0;
  let inQuotes = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (c === LF || c === CR) break;
      if (c === 59) semi++;
      else if (c === 44) comma++;
    }
  }
  return semi > 0 || comma === 0 ? ";" : ",";
}

export function parseCsv(text: string): ParsedCsv {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw tooLarge();
  const begin = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const delimiter = detectDelimiter(text, begin);
  const delimCode = delimiter.charCodeAt(0);

  let header: string[] | null = null;
  const rows: { line: number; cells: string[] }[] = [];

  let cells: string[] = [];
  let field = "";
  let fieldQuoted = false;
  // 0 = Feldanfang, 1 = unquoted, 2 = in Quotes, 3 = nach schliessendem Quote
  let state = 0;
  let line = 1;
  let rowStartLine = 1;
  let quoteOpenLine = 1;
  let rowHasContent = false;

  const endField = (): void => {
    cells.push(field);
    field = "";
    fieldQuoted = false;
    state = 0;
  };

  const endRow = (): void => {
    endField();
    const current = cells;
    cells = [];
    const blank = current.every((c) => c === "");
    rowHasContent = false;
    if (blank) return;
    if (header === null) {
      if (current.length > MAX_IMPORT_COLUMNS) {
        throw new CsvLimitError(`Zu viele Spalten (höchstens ${MAX_IMPORT_COLUMNS}).`);
      }
      header = current.map((h) => h.trim());
      return;
    }
    if (current.length > header.length) {
      throw new CsvFormatError("Mehr Zellen als Spalten in der Kopfzeile.", rowStartLine);
    }
    while (current.length < header.length) current.push("");
    if (rows.length >= MAX_IMPORT_ROWS) {
      throw new CsvLimitError(`Zu viele Zeilen (höchstens ${MAX_IMPORT_ROWS} Datenzeilen).`);
    }
    rows.push({ line: rowStartLine, cells: current });
  };

  const append = (ch: string): void => {
    if (field.length >= MAX_CELL_CHARS) {
      throw new CsvLimitError(`Zelle zu lang (höchstens ${MAX_CELL_CHARS} Zeichen), Zeile ${line}.`);
    }
    field += ch;
  };

  for (let i = begin; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (state === 2) {
      if (c === QUOTE) {
        if (text.charCodeAt(i + 1) === QUOTE) {
          append('"');
          i++;
        } else {
          state = 3;
        }
      } else {
        if (c === LF) line++;
        else if (c === CR) {
          if (text.charCodeAt(i + 1) === LF) {
            // CRLF in Quotes bleibt unveraendert Teil der Zelle
            append("\r");
            i++;
            append("\n");
            line++;
            continue;
          }
          line++;
        }
        append(text[i]);
      }
      continue;
    }

    if (c === LF || c === CR) {
      if (c === CR && text.charCodeAt(i + 1) === LF) i++;
      if (rowHasContent || cells.length > 0 || field !== "" || fieldQuoted) endRow();
      line++;
      rowStartLine = line;
      state = 0;
      continue;
    }
    if (state === 3) {
      if (c === delimCode) {
        endField();
        continue;
      }
      throw new CsvFormatError("Unerwartetes Zeichen nach schließendem Anführungszeichen.", line);
    }
    if (c === delimCode) {
      rowHasContent = true;
      endField();
      continue;
    }
    if (state === 0 && c === QUOTE) {
      state = 2;
      fieldQuoted = true;
      rowHasContent = true;
      quoteOpenLine = line;
      continue;
    }
    if (state === 0) {
      state = 1;
      rowHasContent = true;
    }
    append(text[i]);
  }

  if (state === 2) throw new CsvFormatError("Anführungszeichen nicht geschlossen.", quoteOpenLine);
  if (rowHasContent || cells.length > 0 || field !== "" || fieldQuoted) endRow();

  if (header === null || rows.length === 0) {
    throw new CsvFormatError("Die Datei enthält keine Datenzeilen.");
  }
  return { delimiter, header, rows };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
