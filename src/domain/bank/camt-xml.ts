/**
 * Sichere XML-Vorpruefung fuer Kontoauszuege (Pruefung in `@/lib/xml/safe`): keine DTD, keine Entities,
 * keine Verarbeitungsanweisungen ausser der XML-Deklaration, begrenzte Groesse und Schachtelungstiefe.
 * Erst danach wird geparst.
 */
import { create } from "xmlbuilder2";
import { assertSafeXml as assertSafeXmlGeneric, MAX_XML_DEPTH, XmlSafetyError } from "@/lib/xml/safe";
import { CamtFormatError, MAX_CAMT_BYTES } from "./errors";

export { MAX_XML_DEPTH };

/** Prueft Groesse, ZIP-Kennung und striktes UTF-8; entfernt eine fuehrende BOM. */
export function decodeCamtBytes(bytes: Uint8Array): string {
  if (bytes.length > MAX_CAMT_BYTES) {
    throw new CamtFormatError("Die Datei ist zu gross (maximal 10 MB).", "TOO_LARGE");
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    throw new CamtFormatError("ZIP-Archive werden nicht unterstuetzt, bitte die XML-Datei entpacken.", "ZIP_NOT_SUPPORTED");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CamtFormatError(
      "Die Datei ist nicht UTF-8-kodiert. Bitte den Kontoauszug als CAMT im UTF-8-Format exportieren.",
      "NOT_UTF8",
    );
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Wirft bei DOCTYPE/ENTITY/Verarbeitungsanweisungen, zu tiefer Schachtelung oder offensichtlich kaputtem Markup. */
export function assertSafeXml(xml: string): void {
  try {
    assertSafeXmlGeneric(xml);
  } catch (e) {
    if (!(e instanceof XmlSafetyError)) throw e;
    if (e.code === "TOO_DEEP") throw new CamtFormatError("Die XML-Struktur ist zu tief verschachtelt.", "TOO_DEEP");
    if (e.code === "FORBIDDEN_MARKUP") {
      throw new CamtFormatError(`Die Datei enthaelt nicht erlaubtes Markup (${e.detail ?? "DTD/Entities"}).`, "FORBIDDEN_MARKUP");
    }
    throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
  }
}

/** Parser-Aufruf (einzige Stelle, die das XML tatsaechlich einliest); nur nach `assertSafeXml` aufrufen. */
export function parseXmlTree(xml: string): unknown {
  // xmlbuilder2 erkennt das Format am Inhalt (XML/JSON/YAML); hier ist nur XML zulaessig.
  if (!xml.trimStart().startsWith("<")) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
  try {
    return create(xml).end({ format: "object" });
  } catch {
    throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
  }
}
