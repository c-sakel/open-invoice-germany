import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyXml, detectContainer } from "@/domain/incoming/detect";
import { IncomingFormatError, type IncomingFormatCode } from "@/domain/incoming/errors";
import { MAX_INCOMING_BYTES } from "@/domain/incoming/limits";

const fx = (name: string): string => readFileSync(`test/fixtures/incoming/${name}`, "utf8");
const bytes = (s: string | number[]): Uint8Array => (typeof s === "string" ? new TextEncoder().encode(s) : Uint8Array.from(s));

function codeOf(fn: () => unknown): IncomingFormatCode | "NO_ERROR" {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    if (e instanceof IncomingFormatError) return e.code;
    throw e;
  }
}

describe("detectContainer", () => {
  it("erkennt PDF und Bilder an den Magic Bytes", () => {
    expect(detectContainer(bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toEqual({ type: "PDF" });
    expect(detectContainer(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toEqual({
      type: "IMAGE",
      mime: "image/png",
    });
    expect(detectContainer(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]))).toEqual({
      type: "IMAGE",
      mime: "image/jpeg",
    });
  });

  it("liest XML mit BOM ohne BOM im Text und kennt keine Endungen", () => {
    const xml = fx("gen-base-ubl.xml");
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(xml)]);
    const c = detectContainer(withBom);
    expect(c.type).toBe("XML");
    if (c.type === "XML") {
      expect(c.text.charCodeAt(0)).not.toBe(0xfeff);
      expect(classifyXml(c.text).syntax).toBe("UBL");
    }
  });

  it("classifyXml toleriert eine BOM vor der Deklaration", () => {
    expect(classifyXml("﻿" + fx("gen-base-cii.xml")).syntax).toBe("CII");
  });

  it("weist ZIP und Office-Dateien ab", () => {
    expect(codeOf(() => detectContainer(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])))).toBe("ZIP_NOT_SUPPORTED");
    expect(codeOf(() => detectContainer(Uint8Array.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])))).toBe("ZIP_NOT_SUPPORTED");
  });

  it("weist andere Typen ab", () => {
    expect(codeOf(() => detectContainer(bytes("GIF89a\u0001\u0000\u0001\u0000")))).toBe("UNSUPPORTED_TYPE");
    expect(codeOf(() => detectContainer(bytes("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")))).toBe("UNSUPPORTED_TYPE");
    expect(codeOf(() => detectContainer(bytes("Das ist keine Rechnung.")))).toBe("UNSUPPORTED_TYPE");
    expect(codeOf(() => detectContainer(Uint8Array.from([1, 2, 0, 3, 4, 0, 0, 9])))).toBe("UNSUPPORTED_TYPE");
  });

  it("HTML mit DOCTYPE wird als verbotenes Markup abgewiesen", () => {
    const c = detectContainer(bytes("<!DOCTYPE html><html><body>x</body></html>"));
    expect(c.type).toBe("XML");
    if (c.type === "XML") expect(codeOf(() => classifyXml(c.text))).toBe("FORBIDDEN_MARKUP");
  });

  it("verlangt strikt UTF-8", () => {
    const latin1 = Uint8Array.from([...bytes("<a>"), 0xe4, ...bytes("</a>")]);
    expect(codeOf(() => detectContainer(latin1))).toBe("NOT_UTF8");
    expect(codeOf(() => detectContainer(bytes('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')))).toBe("UNSUPPORTED_ENCODING");
    expect(codeOf(() => detectContainer(bytes('<?xml version="1.0" encoding="UTF-16"?><a/>')))).toBe("UNSUPPORTED_ENCODING");
    expect(codeOf(() => detectContainer(bytes('<?xml version="1.0" encoding="utf-8"?><a/>')))).toBe("NO_ERROR");
  });

  it("prueft Groesse vor dem Dekodieren und leere Dateien", () => {
    expect(codeOf(() => detectContainer(new Uint8Array(0)))).toBe("EMPTY");
    expect(codeOf(() => detectContainer(new Uint8Array(MAX_INCOMING_BYTES + 1)))).toBe("TOO_LARGE");
  });
});

describe("classifyXml", () => {
  it("fremde Wurzel -> NOT_AN_INVOICE", () => {
    const camt = '<?xml version="1.0"?><camt:Document xmlns:camt="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><camt:x/></camt:Document>';
    expect(codeOf(() => classifyXml(camt))).toBe("NOT_AN_INVOICE");
    // Wurzelname passt, Namensraum nicht
    expect(codeOf(() => classifyXml("<Invoice><a/></Invoice>"))).toBe("NOT_AN_INVOICE");
  });

  it("DTD, Entities und kaputtes XML werden abgewiesen, bevor geparst wird", () => {
    expect(codeOf(() => classifyXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'))).toBe("FORBIDDEN_MARKUP");
    expect(codeOf(() => classifyXml("<a><b></a>"))).toBe("MALFORMED");
    expect(codeOf(() => classifyXml("{}"))).toBe("MALFORMED");
  });

  it("Namensraum zaehlt, nicht der Praefix (Praefix plus Default-Namensraum)", () => {
    const c = classifyXml(fx("ubl-invoice-praefix.xml"));
    expect(c).toMatchObject({ syntax: "UBL", root: "Invoice", xrechnung: true, isEInvoice: true });
  });

  it("XRechnung UBL und CII", () => {
    expect(classifyXml(fx("gen-base-ubl.xml"))).toMatchObject({ syntax: "UBL", xrechnung: true, isEInvoice: true });
    expect(classifyXml(fx("cii-xrechnung.xml"))).toMatchObject({ syntax: "CII", xrechnung: true, isEInvoice: true });
    expect(classifyXml(fx("ubl-creditnote.xml"))).toMatchObject({ syntax: "UBL", root: "CreditNote", xrechnung: true });
  });

  it("EN 16931 und EXTENDED", () => {
    expect(classifyXml(fx("gen-base-cii.xml"))).toMatchObject({
      syntax: "CII",
      profile: "urn:cen.eu:en16931:2017",
      xrechnung: false,
      isEInvoice: true,
    });
    expect(classifyXml(fx("cii-extended.xml"))).toMatchObject({ syntax: "CII", xrechnung: false, isEInvoice: true });
    expect(classifyXml(fx("cii-extended.xml")).profile).toContain("extended");
  });

  it("MINIMUM und BASIC WL sind keine EN-16931-Rechnung", () => {
    expect(classifyXml(fx("cii-minimum.xml"))).toMatchObject({ isEInvoice: false, reason: "PROFILE_MINIMUM" });
    expect(classifyXml(fx("cii-basicwl.xml"))).toMatchObject({ isEInvoice: false, reason: "PROFILE_BASICWL" });
  });

  it("ZUGFeRD 1.0", () => {
    expect(classifyXml(fx("ferd-1p0.xml"))).toMatchObject({ syntax: "FERD1", isEInvoice: false, reason: "ZUGFERD_1" });
  });
});
