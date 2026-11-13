import { describe, it, expect } from "vitest";
import {
  CsvFormatError,
  CsvLimitError,
  MAX_IMPORT_BYTES,
  decodeCsvBytes,
  parseCsv,
  sha256Hex,
} from "@/domain/import/parse-csv";

describe("parseCsv", () => {
  it("Quoting, Semikolon und maskierte Quotes", () => {
    const r = parseCsv('h1;h2;h3\na;"b;c";"d""e"\n');
    expect(r.rows[0].cells).toEqual(["a", "b;c", 'd"e']);
    expect(r.delimiter).toBe(";");
  });
  it("Umbruch in Quotes bleibt in der Zelle, Zeilennummern stimmen", () => {
    const r = parseCsv('h1;h2\r\n"a\r\nb";x\r\n"c\nd";y\r\nz;w');
    expect(r.rows.map((x) => x.line)).toEqual([2, 4, 6]);
    expect(r.rows[0].cells[0]).toBe("a\r\nb");
    expect(r.rows[1].cells[0]).toBe("c\nd");
  });
  it("LF, CRLF und CR", () => {
    for (const nl of ["\n", "\r\n", "\r"]) {
      const r = parseCsv(`a;b${nl}1;2${nl}3;4${nl}`);
      expect(r.rows.map((x) => x.cells)).toEqual([["1", "2"], ["3", "4"]]);
      expect(r.rows.map((x) => x.line)).toEqual([2, 3]);
    }
  });
  it("BOM entfernt, Komma erkannt, Kopf mit ; und , -> ;", () => {
    expect(parseCsv("﻿a,b\n1,2").header).toEqual(["a", "b"]);
    expect(parseCsv("a,b\n1,2").delimiter).toBe(",");
    expect(parseCsv("a;b,c\n1;2").delimiter).toBe(";");
  });
  it("leere Zeilen und reine Trennzeichen-Zeilen werden uebersprungen", () => {
    const r = parseCsv("a;b\n\n;\n1;2\n\n");
    expect(r.rows).toEqual([{ line: 4, cells: ["1", "2"] }]);
  });
  it("Formatfehler mit Zeile", () => {
    expect(() => parseCsv('a;b\n1;"x')).toThrow(CsvFormatError);
    try { parseCsv('a;b\n1;"x'); } catch (e) { expect((e as CsvFormatError).line).toBe(2); }
    expect(() => parseCsv('a;b\n"a"b;1')).toThrow(CsvFormatError);
    try { parseCsv("a;b\n1;2;3"); } catch (e) { expect((e as CsvFormatError).line).toBe(2); }
    expect(() => parseCsv("a;b\n1;2;3")).toThrow(CsvFormatError);
  });
  it("weniger Zellen werden aufgefuellt", () => {
    expect(parseCsv("a;b;c\n1").rows[0].cells).toEqual(["1", "", ""]);
  });
  it("leere Datei oder nur Kopf", () => {
    expect(() => parseCsv("")).toThrow(/keine Datenzeilen/);
    expect(() => parseCsv("a;b\n")).toThrow(/keine Datenzeilen/);
  });
  it("Limits: Zeilen, Spalten, Zelle, Groesse", () => {
    const ok = "a\n" + Array.from({ length: 2000 }, (_, i) => String(i)).join("\n");
    expect(parseCsv(ok).rows).toHaveLength(2000);
    expect(() => parseCsv(ok + "\nx")).toThrow(CsvLimitError);
    const big = "a\n" + Array.from({ length: 5000 }, (_, i) => String(i)).join("\n");
    expect(() => parseCsv(big)).toThrow(CsvLimitError);
    expect(() => parseCsv(Array.from({ length: 61 }, (_, i) => `c${i}`).join(";") + "\n1")).toThrow(CsvLimitError);
    expect(() => parseCsv(`a\n${"x".repeat(5001)}`)).toThrow(CsvLimitError);
    expect(parseCsv(`a\n${"x".repeat(5000)}`).rows).toHaveLength(1);
    expect(() => parseCsv("a\n" + "x".repeat(MAX_IMPORT_BYTES))).toThrow(CsvLimitError);
  });
  it("Pathologische Eingabe laeuft linear", () => {
    const t0 = Date.now();
    expect(() => parseCsv('a\n"' + '""'.repeat(2500))).toThrow(CsvFormatError);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("decodeCsvBytes", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it("UTF-8 mit BOM", () => {
    const b = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("Müller")]);
    expect(decodeCsvBytes(b)).toEqual({ text: "Müller", encoding: "utf-8" });
  });
  it("Windows-1252", () => {
    expect(decodeCsvBytes(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]))).toEqual({ text: "Müller", encoding: "windows-1252" });
    expect(decodeCsvBytes(new Uint8Array([0x80, 0xfc])).text).toBe("€ü");
  });
  it("UTF-16-BOM und Groesse", () => {
    expect(() => decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x61, 0]))).toThrow(CsvFormatError);
    expect(() => decodeCsvBytes(new Uint8Array(MAX_IMPORT_BYTES + 1))).toThrow(CsvLimitError);
  });
});

describe("sha256Hex", () => {
  it("deterministisch", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
  });
});
