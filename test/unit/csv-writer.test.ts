import { describe, expect, it } from "vitest";
import { CSV_BOM, col, csvTable, csvTextCell, formatBerlinDateDe, stripFormulaGuard } from "@/domain/export/csv-writer";
import { csvResponse } from "@/lib/http/csv-response";

describe("csvTextCell", () => {
  it.each([
    ["=SUMME(A1)", "'=SUMME(A1)"],
    [" =1", "' =1"],
    ["　=1", "'　=1"],
    ["＝1", "'＝1"],
    ["+49 30 1", "'+49 30 1"],
    ["-5", "'-5"],
    ["@x", "'@x"],
    ["a;b", '"a;b"'],
    ['a"b', '"a""b"'],
    ["a\nb", '"a\nb"'],
    ["normal", "normal"],
    ["\u200b=1", "'\u200b=1"],
    ["\u200c+1", "'\u200c+1"],
    ["\u200d-1", "'\u200d-1"],
    ["\u2060@x", "'\u2060@x"],
    ["\ufeff=1", "'\ufeff=1"],
    ["\u00a0=1", "'\u00a0=1"],
    ["\u0000=1", "'\u0000=1"],
    ["\u2003 =1", "'\u2003 =1"],
    ["\u200b\u00a0 =1", "'\u200b\u00a0 =1"],
  ])("%j -> %j", (input, out) => {
    expect(csvTextCell(input)).toBe(out);
  });
  it("null ist leer", () => expect(csvTextCell(null)).toBe(""));
});

describe("stripFormulaGuard", () => {
  it.each(["=A1", "+49 30 1", "-5", "@a", " =1", "＝1"])("Rueckweg fuer %j", (x) => {
    expect(stripFormulaGuard(csvTextCell(x))).toBe(x);
  });
  it("laesst gewoenliche Apostrophe stehen", () => {
    expect(stripFormulaGuard("'abc")).toBe("'abc");
    expect(stripFormulaGuard("'")).toBe("'");
  });
});

describe("csvTable", () => {
  type R = { t: string | null; c: number | null; b: boolean; d: Date; z: Date };
  const rows: R[] = [
    { t: "x", c: -1234, b: true, d: new Date("2165-01-15T00:00:00Z"), z: new Date("2165-01-14T23:30:00Z") },
    { t: null, c: null, b: false, d: new Date("2165-01-15T00:00:00Z"), z: new Date("2165-07-14T22:30:00Z") },
  ];
  const cols = [
    col<R>("=X", "text", (r) => r.t),
    col<R>("Betrag", "cents", (r) => r.c),
    col<R>("Ja", "bool", (r) => r.b),
    col<R>("D", "date", (r) => r.d),
    col<R>("B", "berlinDate", (r) => r.z),
  ];
  it("formatiert Zellen, schuetzt Kopf, CRLF", () => {
    expect(csvTable(cols, rows)).toBe("'=X;Betrag;Ja;D;B\r\nx;-12,34;ja;15.01.2165;15.01.2165\r\n;;nein;15.01.2165;15.07.2165\r\n");
  });
  it("Berliner Tag", () => {
    expect(formatBerlinDateDe(new Date("2165-01-14T23:30:00Z"))).toBe("15.01.2165");
  });
});

describe("csvResponse", () => {
  it("setzt BOM und Header", async () => {
    const res = csvResponse("a;b\r\n", "rechnungen-2165-01-15.csv");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(CSV_BOM).toBe("﻿");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="rechnungen-2165-01-15.csv"');
  });
  it.each(['a"b.csv', "a;b.csv", "ä.csv", "a/b.csv"])("lehnt %j ab", (n) => {
    expect(() => csvResponse("", n)).toThrow();
  });
});
