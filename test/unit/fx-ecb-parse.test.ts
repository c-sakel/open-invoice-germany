import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEcbXml, parseEcbXmlDetailed } from "@/domain/fx/fetch-ecb";
import { EDITOR_CURRENCIES } from "@/lib/currencies";

const daily = readFileSync("test/fixtures/ecb-daily.xml", "utf8");
const hist = readFileSync("test/fixtures/ecb-hist-90d.xml", "utf8");

describe("parseEcbXml", () => {
  it("liest Tageskurse als Micros mit Datum UTC-Mitternacht", () => {
    const rows = parseEcbXml(daily);
    const usd = rows.find((r) => r.currency === "USD");
    expect(usd).toEqual({ source: "ECB", currency: "USD", rateDate: new Date("2026-11-11T00:00:00.000Z"), rateMicros: 1_112_700 });
    expect(rows.find((r) => r.currency === "SEK")?.rateMicros).toBe(11_051_000);
  });

  it("enthaelt alle Editor-Waehrungen ausser EUR; IDR (ueber 2000 je EUR) fehlt", () => {
    const rows = parseEcbXml(daily);
    for (const c of EDITOR_CURRENCIES.filter((x) => x !== "EUR")) expect(rows.some((r) => r.currency === c)).toBe(true);
    expect(rows.some((r) => r.currency === "IDR")).toBe(false);
    expect(parseEcbXmlDetailed(daily).skipped.map((s) => s.currency)).toContain("IDR");
  });

  it("liest die 90-Tage-Datei mit mehreren Tagen", () => {
    const rows = parseEcbXml(hist);
    expect(new Set(rows.map((r) => r.rateDate.getTime())).size).toBeGreaterThan(30);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(["USD", "GBP", "CHF"]));
  });

  it("lehnt fremde Struktur und kaputtes XML ab", () => {
    expect(() => parseEcbXml("<html><body>Wartung</body></html>")).toThrow(/Struktur/);
    expect(() => parseEcbXml("<<<")).toThrow(/nicht lesbar/);
  });

  it("ueberspringt ungueltige Kurswerte und wirft bei ungueltigem Datum", () => {
    const ns = 'xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"';
    const bad = `<gesmes:Envelope ${ns}><Cube><Cube time="2108-02-03"><Cube currency="USD" rate="abc"/><Cube currency="GBP" rate="0.8"/></Cube></Cube></gesmes:Envelope>`;
    const res = parseEcbXmlDetailed(bad);
    expect(res.rows.map((r) => r.currency)).toEqual(["GBP"]);
    expect(res.skipped.map((s) => s.currency)).toEqual(["USD"]);
    expect(() => parseEcbXml(bad.replace("2108-02-03", "2108-02-31"))).toThrow(/Datum/);
  });
});
