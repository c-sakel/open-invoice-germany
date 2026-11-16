import { describe, expect, it } from "vitest";
import { assertSafeXml, MAX_XML_DEPTH, XmlSafetyError, xmlDeclaredEncoding, type XmlSafetyCode } from "@/lib/xml/safe";

function codeOf(xml: string): XmlSafetyCode | undefined {
  try {
    assertSafeXml(xml);
  } catch (e) {
    if (e instanceof XmlSafetyError) return e.code;
    throw e;
  }
  return undefined;
}

const nested = (depth: number): string => "<a>".repeat(depth) + "x" + "</a>".repeat(depth);

describe("assertSafeXml", () => {
  it("laesst gueltiges XML mit Deklaration, Kommentar und CDATA zu", () => {
    expect(codeOf('<?xml version="1.0" encoding="UTF-8"?>\n<r><!-- k --><a x="1">t</a><![CDATA[<b>]]></r>')).toBeUndefined();
  });

  it("lehnt DOCTYPE und Entities ab", () => {
    expect(codeOf('<?xml version="1.0"?>\n<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<d>&x;</d>')).toBe("FORBIDDEN_MARKUP");
  });

  it("lehnt Billion Laughs ab", () => {
    const xml =
      '<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY a0 "lol"><!ENTITY a1 "&a0;&a0;&a0;&a0;&a0;&a0;&a0;&a0;&a0;&a0;">]>\n<lolz>&a1;</lolz>';
    expect(codeOf(xml)).toBe("FORBIDDEN_MARKUP");
  });

  it("lehnt Verarbeitungsanweisungen ab", () => {
    expect(codeOf('<?xml version="1.0"?><r><?php echo 1; ?></r>')).toBe("FORBIDDEN_MARKUP");
    expect(codeOf('<?xml-stylesheet href="x"?><r/>')).toBe("FORBIDDEN_MARKUP");
  });

  it("begrenzt die Tiefe auf 64", () => {
    expect(MAX_XML_DEPTH).toBe(64);
    expect(codeOf(nested(64))).toBeUndefined();
    expect(codeOf(nested(65))).toBe("TOO_DEEP");
  });

  it("lehnt Text ausserhalb der Wurzel, zwei Wurzeln und Nicht-XML ab", () => {
    expect(codeOf("<r/>text")).toBe("MALFORMED");
    expect(codeOf("text<r/>")).toBe("MALFORMED");
    expect(codeOf("<r/><s/>")).toBe("MALFORMED");
    expect(codeOf('{"a":1}')).toBe("MALFORMED");
    expect(codeOf("<r><a></r>")).toBe("MALFORMED");
    expect(codeOf("")).toBe("MALFORMED");
  });
});

describe("xmlDeclaredEncoding", () => {
  it("liest das Attribut aus der Deklaration", () => {
    expect(xmlDeclaredEncoding('<?xml version="1.0" encoding="ISO-8859-1"?>')).toBe("ISO-8859-1");
    expect(xmlDeclaredEncoding("<?xml version='1.0' encoding='utf-8'?><r/>")).toBe("utf-8");
    expect(xmlDeclaredEncoding('﻿<?xml version="1.0" encoding="UTF-8"?><r/>')).toBe("UTF-8");
  });

  it("liefert null ohne Deklaration oder ohne encoding", () => {
    expect(xmlDeclaredEncoding("<r/>")).toBeNull();
    expect(xmlDeclaredEncoding('<?xml version="1.0"?><r encoding="x"/>')).toBeNull();
  });
});
