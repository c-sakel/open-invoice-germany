/**
 * Sichere XML-Vorpruefung fuer fremde Dateien: keine DTD, keine Entities, keine Verarbeitungsanweisungen
 * ausser der XML-Deklaration, begrenzte Schachtelungstiefe. Fremdes XML darf erst nach `assertSafeXml`
 * einen Parser erreichen.
 */

export const MAX_XML_DEPTH = 64;

export type XmlSafetyCode = "FORBIDDEN_MARKUP" | "TOO_DEEP" | "MALFORMED";

export class XmlSafetyError extends Error {
  constructor(
    readonly code: XmlSafetyCode,
    readonly detail?: string,
  ) {
    super(code === "FORBIDDEN_MARKUP" ? `Nicht erlaubtes Markup (${detail ?? "DTD/Entities"})` : code);
    this.name = "XmlSafetyError";
  }
}

/**
 * Wert des `encoding`-Attributs der XML-Deklaration (nur am Dateianfang, nach optionaler BOM) oder null.
 */
export function xmlDeclaredEncoding(xml: string): string | null {
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const decl = /^<\?xml\s[^>]*?\?>/.exec(text)?.[0];
  if (!decl) return null;
  const m = /\sencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(decl);
  return m ? (m[1] ?? m[2] ?? null) : null;
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
export function assertSafeXml(input: string): void {
  const xml = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const notXml = (): never => {
    throw new XmlSafetyError("MALFORMED");
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
      if (end === -1) throw new XmlSafetyError("MALFORMED");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlSafetyError("MALFORMED");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      throw new XmlSafetyError("FORBIDDEN_MARKUP", "DTD/Entities");
    }
    if (xml.startsWith("<?", lt)) {
      // Nur die XML-Deklaration ganz am Anfang ist erlaubt.
      if (lt === 0 && /^<\?xml[\s?]/.test(xml.slice(0, 8))) {
        const end = xml.indexOf("?>", lt + 2);
        if (end === -1) throw new XmlSafetyError("MALFORMED");
        i = end + 2;
        continue;
      }
      if (lt === start && /^<\?xml[\s?]/.test(xml.slice(lt, lt + 8))) notXml(); // Deklaration nach Leerraum
      throw new XmlSafetyError("FORBIDDEN_MARKUP", "Verarbeitungsanweisung");
    }
    const end = tagEnd(xml, lt + 1);
    if (end === -1) throw new XmlSafetyError("MALFORMED");
    const name = /^\/?([^\s/>]+)/.exec(xml.slice(lt + 1, end))?.[1];
    if (!name) throw new XmlSafetyError("MALFORMED");
    if (xml[lt + 1] === "/") {
      if (stack.pop() !== name) throw new XmlSafetyError("MALFORMED");
    } else {
      if (stack.length === 0 && ++roots > 1) notXml();
      if (xml[end - 1] !== "/") stack.push(name);
    }
    if (xml[lt + 1] !== "/" && xml[end - 1] !== "/") {
      if (stack.length > MAX_XML_DEPTH) {
        throw new XmlSafetyError("TOO_DEEP");
      }
    }
    i = end + 1;
  }
  if (stack.length > 0) throw new XmlSafetyError("MALFORMED");
}
