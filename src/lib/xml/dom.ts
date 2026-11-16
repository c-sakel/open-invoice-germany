/**
 * Namespace-bewusster Zugriff auf fremdes XML. Der Parser darf nur nach `assertSafeXml` aufgerufen
 * werden (keine DTD, keine Entities). Elemente werden ueber Namensraum-URI und lokalen Namen gefunden,
 * nie ueber Praefixe. Der Namensraum kommt vom SAX-Parser (xmlns-Modus); ein DOM-Aufbau ueber
 * xmlbuilder2 wird nicht genutzt, weil es bei Praefix plus Default-Namensraum den falschen Namensraum
 * zuweist.
 */
import { SaxesParser } from "saxes";

export type NsMap = Readonly<Record<string, string>>;

/** Schlankes Element: lokaler Name, Namensraum, Attribute, Kinder, eigener Text. */
export class XmlElement {
  readonly children: XmlElement[] = [];
  private readonly texts: string[] = [];
  constructor(
    readonly localName: string,
    readonly namespaceURI: string,
    private readonly attrs: ReadonlyMap<string, string>,
  ) {}

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addText(t: string): void {
    this.texts.push(t);
  }

  /** Text des Elements einschliesslich aller Nachfahren (Dokumentreihenfolge ohne Mischinhalt-Garantie). */
  get textContent(): string {
    if (this.children.length === 0) return this.texts.join("");
    return this.texts.join("") + this.children.map((c) => c.textContent).join("");
  }
}

/** Parst Text zu einem Baum und liefert das Wurzelelement. Wirft bei Syntaxfehlern. */
export function parseXmlDom(text: string): XmlElement {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  parser.on("error", (e) => {
    throw e;
  });
  parser.on("opentag", (tag) => {
    const attrs = new Map<string, string>();
    for (const a of Object.values(tag.attributes)) {
      // Nur Attribute ohne Praefix (unitCode, currencyID, format, schemeID ...) werden gelesen.
      if (a.prefix === "" && a.uri === "") attrs.set(a.local, a.value);
    }
    const el = new XmlElement(tag.local, tag.uri, attrs);
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else root = el;
    stack.push(el);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const onText = (t: string): void => {
    stack[stack.length - 1]?.addText(t);
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.write(text).close();
  if (!root) throw new Error("Kein Wurzelelement");
  return root;
}

function splitName(name: string, ns: NsMap): { uri: string; local: string } {
  const idx = name.indexOf(":");
  const prefix = idx === -1 ? "" : name.slice(0, idx);
  const local = idx === -1 ? name : name.slice(idx + 1);
  const uri = ns[prefix];
  if (uri === undefined) throw new Error(`Unbekanntes Praefix ${prefix}`);
  return { uri, local };
}

/** Direkte Kindelemente `prefix:local` (Praefix nur als Schluessel von `ns`). */
export function children(el: XmlElement, ns: NsMap, name: string): XmlElement[] {
  const { uri, local } = splitName(name, ns);
  return el.children.filter((c) => c.localName === local && c.namespaceURI === uri);
}

export function child(el: XmlElement, ns: NsMap, name: string): XmlElement | null {
  return children(el, ns, name)[0] ?? null;
}

/** Alle Elemente entlang eines Pfads `a:b/c:d` (jeder Schritt direkte Kinder). */
export function findAll(el: XmlElement, ns: NsMap, path: string): XmlElement[] {
  let current: XmlElement[] = [el];
  for (const step of path.split("/")) {
    const next: XmlElement[] = [];
    for (const c of current) next.push(...children(c, ns, step));
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

export function find(el: XmlElement, ns: NsMap, path: string): XmlElement | null {
  return findAll(el, ns, path)[0] ?? null;
}

/** Getrimmter Text oder null, wenn leer. */
export function text(el: XmlElement | null | undefined): string | null {
  if (!el) return null;
  const t = (el.textContent ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Text am Pfad. */
export function textAt(el: XmlElement | null, ns: NsMap, path: string): string | null {
  return el ? text(find(el, ns, path)) : null;
}

/** Attribut ohne Namensraum. */
export function attr(el: XmlElement | null | undefined, name: string): string | null {
  if (!el) return null;
  const v = el.getAttribute(name);
  return v === null || v === "" ? null : v;
}

/** Erstes Nachfahren-Element mit lokalem Namen (beliebiger Namensraum), begrenzt auf `maxDepth`. */
export function descendantByLocalName(el: XmlElement, local: string, maxDepth = 8): XmlElement | null {
  if (maxDepth < 0) return null;
  for (const c of el.children) {
    if (c.localName === local) return c;
    const deep = descendantByLocalName(c, local, maxDepth - 1);
    if (deep) return deep;
  }
  return null;
}
