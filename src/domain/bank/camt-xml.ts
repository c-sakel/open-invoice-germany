/**
 * Sichere XML-Vorpruefung fuer Kontoauszuege: keine DTD, keine Entities, keine Verarbeitungsanweisungen
 * ausser der XML-Deklaration, begrenzte Groesse und Schachtelungstiefe. Erst danach wird geparst.
 */
import { create } from "xmlbuilder2";
import { CamtFormatError, MAX_CAMT_BYTES } from "./errors";

export const MAX_XML_DEPTH = 64;

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

/** Index nach dem Ende des Tags ab `from` (Anfuehrungszeichen beachten); -1 wenn nicht geschlossen. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Wirft bei DOCTYPE/ENTITY/Verarbeitungsanweisungen, zu tiefer Schachtelung oder offensichtlich kaputtem Markup. */
export function assertSafeXml(xml: string): void {
  const notXml = (): never => {
    throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
  };
  // Nur echtes XML: nach der BOM (bereits entfernt) und Leerraum muss ein Tag beginnen. Der Parser erkennt
  // sonst JSON/YAML am Inhalt und wuerde die Pruefungen unten umgehen.
  const start = xml.search(/\S/);
  if (start === -1 || xml[start] !== "<") notXml();
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (stack.length === 0 && /\S/.test(xml.slice(i, lt === -1 ? n : lt))) notXml(); // Text ausserhalb der Wurzel
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      throw new CamtFormatError("Die Datei enthaelt nicht erlaubtes Markup (DTD/Entities).", "FORBIDDEN_MARKUP");
    }
    if (xml.startsWith("<?", lt)) {
      // Nur die XML-Deklaration ganz am Anfang ist erlaubt.
      if (lt === 0 && /^<\?xml[\s?]/.test(xml.slice(0, 8))) {
        const end = xml.indexOf("?>", lt + 2);
        if (end === -1) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
        i = end + 2;
        continue;
      }
      if (lt === start && /^<\?xml[\s?]/.test(xml.slice(lt, lt + 8))) notXml(); // Deklaration nach Leerraum
      throw new CamtFormatError("Die Datei enthaelt nicht erlaubtes Markup (Verarbeitungsanweisung).", "FORBIDDEN_MARKUP");
    }
    const end = tagEnd(xml, lt + 1);
    if (end === -1) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
    const name = /^\/?([^\s/>]+)/.exec(xml.slice(lt + 1, end))?.[1];
    if (!name) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
    if (xml[lt + 1] === "/") {
      if (stack.pop() !== name) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
    } else {
      if (stack.length === 0 && ++roots > 1) notXml();
      if (xml[end - 1] !== "/") stack.push(name);
    }
    if (xml[lt + 1] !== "/" && xml[end - 1] !== "/") {
      if (stack.length > MAX_XML_DEPTH) {
        throw new CamtFormatError("Die XML-Struktur ist zu tief verschachtelt.", "TOO_DEEP");
      }
    }
    i = end + 1;
  }
  if (stack.length > 0) throw new CamtFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
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
