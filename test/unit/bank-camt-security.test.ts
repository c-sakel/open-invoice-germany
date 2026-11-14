import { describe, expect, it, vi } from "vitest";
import * as xml from "@/domain/bank/camt-xml";
import { assertSafeXml, decodeCamtBytes } from "@/domain/bank/camt-xml";
import { parseCamt } from "@/domain/bank/camt-parse";
import { CamtFormatError, MAX_CAMT_BYTES } from "@/domain/bank/errors";
import { buildCamt } from "../helpers/camt-builder";

const IBAN = "DE89370400440532013000";
const valid = (): string =>
  buildCamt({ format: "053", version: 2, iban: IBAN, entries: [{ date: "2200-06-05", txs: [{ amountCents: 100, remittance: "ok" }] }] });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CamtFormatError) return e.code;
    throw e;
  }
  return undefined;
}

describe("CAMT-Sicherheit", () => {
  const xxe = `<?xml version="1.0"?>\n<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<Document>&x;</Document>`;
  const laughs =
    `<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY a0 "lol">` +
    Array.from({ length: 10 }, (_, i) => `<!ENTITY a${i + 1} "&a${i};&a${i};&a${i};&a${i};&a${i};&a${i};&a${i};&a${i};&a${i};&a${i};">`).join("") +
    `]>\n<Document>&a10;</Document>`;

  it("lehnt DOCTYPE (XXE, Billion Laughs) ab, ohne dass der Parser das XML sieht", () => {
    const spy = vi.spyOn(xml, "parseXmlTree");
    try {
      expect(codeOf(() => parseCamt(xxe))).toBe("FORBIDDEN_MARKUP");
      expect(codeOf(() => parseCamt(laughs))).toBe("FORBIDDEN_MARKUP");
      expect(codeOf(() => parseCamt(valid().replace("<Document", "<!DOCTYPE Document>\n<Document")))).toBe("FORBIDDEN_MARKUP");
      expect(spy).not.toHaveBeenCalled();
      parseCamt(valid());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("lehnt Verarbeitungsanweisungen ab, erlaubt Kommentar und CDATA", () => {
    const ss = valid().replace("<Document", '<?xml-stylesheet href="x.xsl"?>\n<Document');
    expect(codeOf(() => parseCamt(ss))).toBe("FORBIDDEN_MARKUP");
    expect(codeOf(() => parseCamt(valid().replace("<Document", "<!-- Kommentar --><Document")))).toBeUndefined();
    const cdata = valid().replace("<Ustrd>ok</Ustrd>", "<Ustrd><![CDATA[a <!DOCTYPE b> & c]]></Ustrd>");
    expect(codeOf(() => parseCamt(cdata))).toBeUndefined();
    expect(parseCamt(cdata).statements[0].transactions[0].remittance).toBe("a <!DOCTYPE b> & c");
  });

  it("begrenzt die Schachtelungstiefe auf 64", () => {
    const deep = (n: number): string => "<a>".repeat(n) + "</a>".repeat(n);
    expect(codeOf(() => assertSafeXml(deep(64)))).toBeUndefined();
    expect(codeOf(() => assertSafeXml(deep(65)))).toBe("TOO_DEEP");
    expect(codeOf(() => parseCamt(deep(65)))).toBe("TOO_DEEP");
    expect(codeOf(() => assertSafeXml(`<r>${"<a/>".repeat(1000)}</r>`))).toBeUndefined();
  });

  it("begrenzt Groesse, Kodierung und Archive", () => {
    expect(codeOf(() => decodeCamtBytes(new Uint8Array(MAX_CAMT_BYTES + 1)))).toBe("TOO_LARGE");
    expect(codeOf(() => decodeCamtBytes(new Uint8Array(MAX_CAMT_BYTES).fill(0x20)))).toBeUndefined();
    expect(codeOf(() => decodeCamtBytes(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])))).toBe("NOT_UTF8");
    expect(codeOf(() => decodeCamtBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])))).toBe("ZIP_NOT_SUPPORTED");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<a/>")]);
    expect(decodeCamtBytes(bom)).toBe("<a/>");
  });

  it("lehnt andere Formate und Versionen ab", () => {
    const camt052 = valid().replace("camt.053.001.02", "camt.052.001.02");
    expect(codeOf(() => parseCamt(camt052))).toBe("UNSUPPORTED_VERSION");
    expect(codeOf(() => parseCamt(valid().replace("camt.053.001.02", "camt.053.001.14")))).toBe("UNSUPPORTED_VERSION");
    const pain = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn/></Document>`;
    expect(codeOf(() => parseCamt(pain))).toBe("UNSUPPORTED_VERSION");
    expect(codeOf(() => parseCamt("<Foo/>"))).toBe("NOT_CAMT");
    expect(codeOf(() => parseCamt(""))).toBe("MALFORMED");
  });

  it("lehnt mehr als 50.000 Ntry ab", () => {
    const xmlText = valid().replace("</Stmt>", "<Ntry/>".repeat(50_000) + "</Stmt>");
    // 50.001 Ntry insgesamt (eines aus dem Builder)
    expect(codeOf(() => parseCamt(xmlText))).toBe("TOO_MANY_ENTRIES");
  });

  it("Fehlermeldungen enthalten keinen Dateiinhalt", () => {
    const secret = "GEHEIM-CAMT";
    const bad = buildCamt({
      format: "053",
      version: 2,
      iban: IBAN,
      entries: [{ date: "2200-06-05", txs: [{ amountCents: 100, remittance: secret }] }],
    });
    const variants = [
      bad.replace("<Document", "<!DOCTYPE Document>\n<Document"),
      bad.replace("2200-06-05", "2200-13-45"),
      bad.replaceAll(">1.00<", ">1.234<"),
      bad.replace(IBAN, "XX"),
      bad.replace("</Document>", ""),
      bad.replace("<Document", "<?pi x?><Document"),
      "<a>".repeat(70) + secret + "</a>".repeat(70),
    ];
    for (const v of variants) {
      try {
        parseCamt(v);
        throw new Error(`erwarteter Fehler blieb aus: ${variants.indexOf(v)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(CamtFormatError);
        expect((e as Error).message).not.toContain(secret);
        expect((e as Error).message).not.toContain(IBAN);
      }
    }
  });
});

describe("CAMT-Sicherheit: nur echtes XML", () => {
  const spy = () => vi.spyOn(xml, "parseXmlTree");
  const json = JSON.stringify({ Document: { "@xmlns": "urn:iso:std:iso:20022:tech:xsd:camt.053.001.02", BkToCstmrStmt: { Stmt: { Acct: { Id: { IBAN: IBAN } } } } } });
  const yaml = `Document:\n  "@xmlns": "urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"\n  BkToCstmrStmt: {}`;

  it("lehnt JSON, YAML, Text ohne Tags und zwei Wurzelelemente ab, ohne den Parser aufzurufen", () => {
    const s = spy();
    try {
      for (const bad of [json, yaml, "nur Text ohne Tags", "", "  \n", `${valid()}<zweite/>`, `<a/><b/>`, `x${valid()}`, `${valid()}\nrest`]) {
        expect(codeOf(() => parseCamt(bad)), bad.slice(0, 30)).toBe("MALFORMED");
      }
      expect(s).not.toHaveBeenCalled();
    } finally {
      s.mockRestore();
    }
  });

  it("XML-Deklaration nach Leerraum ist MALFORMED, mit fuehrendem Leerraum vor der Wurzel ohne Deklaration ok", () => {
    expect(codeOf(() => parseCamt(`\n${valid()}`))).toBe("MALFORMED");
    expect(codeOf(() => parseCamt(valid().replace(/^<\?xml[^>]*\?>\s*/, "\n  ")))).toBeUndefined();
  });

  it("parseXmlTree selbst nimmt kein JSON an", () => {
    expect(codeOf(() => xml.parseXmlTree(json))).toBe("MALFORMED");
  });

  it("Nicht-UTF-8 nennt die Abhilfe", () => {
    try {
      decodeCamtBytes(new Uint8Array([0x3c, 0xe4, 0x3e]));
      throw new Error("kein Fehler");
    } catch (e) {
      expect((e as CamtFormatError).message).toContain("UTF-8");
      expect((e as CamtFormatError).message).toContain("exportieren");
    }
  });
});
