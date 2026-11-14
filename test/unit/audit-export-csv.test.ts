import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { uniqueFileStem } from "@/domain/audit/export";
import { csvRow, formatCentsDe, formatDateDe, formatMilliCentsDe, formatMilliDe } from "@/domain/audit/export-csv";
import { buildIndexXml, GDPDU_DTD } from "@/domain/audit/gdpdu/index-xml";
import { auditExportQuerySchema, auditExportRange } from "@/schemas/audit";

describe("Export-CSV", () => {
  it("formatiert Cent, Menge und Datum deutsch", () => {
    expect(formatCentsDe(-1234)).toBe("-12,34");
    expect(formatCentsDe(5)).toBe("0,05");
    expect(formatCentsDe(0)).toBe("0,00");
    expect(formatCentsDe(1234567)).toBe("12345,67");
    expect(formatMilliDe(1500)).toBe("1,500");
    expect(formatDateDe(new Date("2013-03-01T23:30:00Z"))).toBe("01.03.2013");
  });

  it("maskiert Semikolon, Anfuehrungszeichen und Zeilenumbrueche; CRLF am Zeilenende", () => {
    expect(csvRow(["a;b", 'x"y', "z\nq", null, 3])).toBe('"a;b";"x""y";"z\nq";;3\r\n');
  });
});

describe("Zeitraum-Schema", () => {
  it("lehnt Umkehr und mehr als drei Jahre ab, akzeptiert genau drei", () => {
    expect(auditExportQuerySchema.safeParse({ from: "2013-02-01", to: "2013-01-01" }).success).toBe(false);
    expect(auditExportQuerySchema.safeParse({ from: "2013-01-01", to: "2017-01-01" }).success).toBe(false);
    expect(auditExportQuerySchema.safeParse({ from: "2013-01-01", to: "2016-01-01" }).success).toBe(true);
    expect(auditExportQuerySchema.safeParse({ from: "2013-01-01", to: "2016-01-02" }).success).toBe(false);
    expect(auditExportQuerySchema.safeParse({ from: "2013-13-01", to: "2013-12-31" }).success).toBe(false);
  });

  it("Bereich ist inklusiv in UTC", () => {
    const r = auditExportRange({ from: "2013-03-01", to: "2013-03-01" });
    expect(r.from.toISOString()).toBe("2013-03-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2013-03-01T23:59:59.999Z");
  });
});

describe("GDPdU", () => {
  it("DTD-Datei und eingebettete Konstante sind identisch", () => {
    expect(readFileSync(path.join(process.cwd(), "src/domain/audit/gdpdu/gdpdu-01-09-2004.dtd"), "utf8")).toBe(GDPDU_DTD);
  });

  it("index.xml maskiert Sonderzeichen", () => {
    const xml = buildIndexXml({
      supplierName: "A & B <GmbH>", supplierLocation: "X", comment: "c",
      tables: [{ file: "a.csv", name: "A", description: "d", columns: [{ name: "x", type: "amount" }] }],
    });
    expect(xml).toContain("A &amp; B &lt;GmbH&gt;");
    expect(xml).toContain("<Accuracy>2</Accuracy>");
  });

  it("Milli-Cent-Spalte (amount5) wird mit Accuracy 5 beschrieben und exakt formatiert", () => {
    const xml = buildIndexXml({
      supplierName: "A", supplierLocation: "X", comment: "c",
      tables: [{ file: "a.csv", name: "A", description: "d", columns: [{ name: "x", type: "amount5" }] }],
    });
    expect(xml).toContain("<Accuracy>5</Accuracy>");
    expect(formatMilliCentsDe(200)).toBe("0,00200");
    expect(formatMilliCentsDe(1234)).toBe("0,01234");
    expect(formatMilliCentsDe(-200)).toBe("-0,00200");
    expect(formatMilliCentsDe(1_234_567)).toBe("12,34567");
  });
});

describe("Dateinamen im Export", () => {
  it("kollidierende Belegnummern (RE/1 und RE_1) bekommen eindeutige Namen", () => {
    const used = new Set<string>();
    const a = uniqueFileStem("RE/1", "aaaaaaaa1111", used);
    const b = uniqueFileStem("RE_1", "bbbbbbbb2222", used);
    expect(a).toBe("RE_1");
    expect(b).toBe("RE_1-bbbbbbbb");
    expect(uniqueFileStem("re_1", "cccccccc3333", used)).not.toBe("re_1");
  });
});
