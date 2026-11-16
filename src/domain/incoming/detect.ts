/**
 * Erkennung von Dateityp (Magic Bytes, nie die Endung) und XML-Syntax/Profil einer Eingangsrechnung.
 */
import { sniffMime } from "@/lib/attachments/mime";
import { assertSafeXml, xmlDeclaredEncoding } from "@/lib/xml/safe";
import { descendantByLocalName, find, parseXmlDom, text, type NsMap, type XmlElement } from "@/lib/xml/dom";
import { IncomingFormatError, toFormatError } from "./errors";
import { MAX_INCOMING_BYTES } from "./limits";

export type Container =
  | { type: "XML"; text: string }
  | { type: "PDF" }
  | { type: "IMAGE"; mime: "image/png" | "image/jpeg" };

export interface XmlClass {
  syntax: "UBL" | "CII" | "FERD1";
  root: string;
  profile: string | null;
  isEInvoice: boolean;
  xrechnung: boolean;
  reason?: "PROFILE_MINIMUM" | "PROFILE_BASICWL" | "ZUGFERD_1";
}

export const NS_UBL_INVOICE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
export const NS_UBL_CREDITNOTE = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
export const NS_UBL_CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
export const NS_UBL_CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
export const NS_CII_RSM = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";
export const NS_CII_RAM = "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100";
export const NS_CII_UDT = "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100";
export const NS_FERD1 = "urn:ferd:CrossIndustryDocument:invoice:1p0";

export const UBL_NS: NsMap = { cac: NS_UBL_CAC, cbc: NS_UBL_CBC };
export const CII_NS: NsMap = { rsm: NS_CII_RSM, ram: NS_CII_RAM, udt: NS_CII_UDT };

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const SNIFF_BYTES = 8192;

function startsWith(b: Uint8Array, magic: number[]): boolean {
  return b.length >= magic.length && magic.every((v, i) => b[i] === v);
}

/** Entfernt eine fuehrende BOM. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function assertUtf8Declaration(text: string): void {
  const enc = xmlDeclaredEncoding(text);
  if (enc !== null && !/^utf-?8$/i.test(enc.trim())) {
    throw new IncomingFormatError(
      "Die Datei ist nicht UTF-8-kodiert. Bitte die Rechnung im UTF-8-Format senden.",
      "UNSUPPORTED_ENCODING",
    );
  }
}

/** Dateityp aus den Bytes. Groesse wird vor dem Dekodieren geprueft. */
export function detectContainer(bytes: Uint8Array): Container {
  if (bytes.length === 0) throw new IncomingFormatError("Die Datei ist leer.", "EMPTY");
  if (bytes.length > MAX_INCOMING_BYTES) {
    throw new IncomingFormatError("Die Datei ist zu gross (maximal 15 MB).", "TOO_LARGE");
  }
  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, ZIP_EMPTY)) {
    throw new IncomingFormatError(
      "ZIP-Archive und Office-Dateien werden nicht unterstuetzt, bitte die Rechnung einzeln senden.",
      "ZIP_NOT_SUPPORTED",
    );
  }
  const head = bytes.subarray(0, SNIFF_BYTES);
  const mime = sniffMime(Buffer.from(head.buffer, head.byteOffset, head.byteLength));
  if (mime === "application/pdf") return { type: "PDF" };
  if (mime === "image/png" || mime === "image/jpeg") return { type: "IMAGE", mime };
  if (mime === "image/gif" || mime === "image/webp" || mime === "ole2" || mime === "ooxml-zip") {
    throw new IncomingFormatError("Dieser Dateityp wird nicht unterstuetzt.", "UNSUPPORTED_TYPE");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    if (head.includes(0)) throw new IncomingFormatError("Dieser Dateityp wird nicht unterstuetzt.", "UNSUPPORTED_TYPE");
    throw new IncomingFormatError(
      "Die Datei ist nicht UTF-8-kodiert. Bitte die Rechnung im UTF-8-Format senden.",
      "NOT_UTF8",
    );
  }
  const t = stripBom(decoded);
  if (!t.trimStart().startsWith("<")) {
    throw new IncomingFormatError("Dieser Dateityp wird nicht unterstuetzt.", "UNSUPPORTED_TYPE");
  }
  assertUtf8Declaration(t);
  return { type: "XML", text: t };
}

function checkSafe(xml: string): string {
  const t = stripBom(xml);
  assertUtf8Declaration(t);
  try {
    assertSafeXml(t);
  } catch (e) {
    throw toFormatError(e);
  }
  return t;
}

/** Sicherheitspruefung und Parsen; einziger Weg von fremdem Text zum DOM. */
export function loadXml(xml: string): XmlElement {
  const safe = checkSafe(xml);
  try {
    return parseXmlDom(safe);
  } catch {
    throw new IncomingFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
  }
}

/** Syntax (UBL/CII/ZUGFeRD 1.0) und Profil. Ruft `assertSafeXml` selbst auf. */
export function classifyXml(xml: string): XmlClass {
  return classifyRoot(loadXml(xml));
}

/** Klassifiziert ein bereits sicher geladenes Wurzelelement. */
export function classifyRoot(root: XmlElement): XmlClass {
  const rootName = root.localName;
  const ns = root.namespaceURI;
  let syntax: XmlClass["syntax"];
  let profile: string | null;
  if (ns === NS_UBL_INVOICE && rootName === "Invoice") {
    syntax = "UBL";
    profile = text(find(root, UBL_NS, "cbc:CustomizationID"));
  } else if (ns === NS_UBL_CREDITNOTE && rootName === "CreditNote") {
    syntax = "UBL";
    profile = text(find(root, UBL_NS, "cbc:CustomizationID"));
  } else if (ns === NS_CII_RSM && rootName === "CrossIndustryInvoice") {
    syntax = "CII";
    profile = text(find(root, CII_NS, "rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID"));
  } else if (ns === NS_FERD1 && rootName === "CrossIndustryDocument") {
    const ctx = descendantByLocalName(root, "GuidelineSpecifiedDocumentContextParameter", 3);
    const id = ctx ? descendantByLocalName(ctx, "ID", 1) : null;
    return { syntax: "FERD1", root: rootName, profile: text(id), isEInvoice: false, xrechnung: false, reason: "ZUGFERD_1" };
  } else {
    throw new IncomingFormatError("Die Datei ist keine unterstuetzte Rechnung.", "NOT_AN_INVOICE");
  }
  const p = profile?.toLowerCase() ?? "";
  const xrechnung = p.includes("xeinkauf.de:kosit:xrechnung");
  if (/[:#]minimum$/.test(p)) return { syntax, root: rootName, profile, isEInvoice: false, xrechnung, reason: "PROFILE_MINIMUM" };
  if (/[:#]basicwl$/.test(p)) return { syntax, root: rootName, profile, isEInvoice: false, xrechnung, reason: "PROFILE_BASICWL" };
  return { syntax, root: rootName, profile, isEInvoice: profile !== null, xrechnung };
}
