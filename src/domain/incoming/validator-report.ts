/**
 * Auswertung des Pruefberichts des Validators (Format "VARL", Namensraum `rep`). Der Bericht
 * stammt aus dem eigenen Pruefprozess; er geht trotzdem durch `assertSafeXml` und den
 * namensraumbewussten Parser. Der eingebettete HTML-Bericht (`rep:assessment`) wird vor dem Parsen
 * abgeschnitten: er ist gross und wird nicht gebraucht.
 */
import { assertSafeXml } from "@/lib/xml/safe";
import { parseXmlDom, type XmlElement } from "@/lib/xml/dom";
import { MAX_FINDING_TEXT, MAX_FINDINGS } from "./limits";

export const REPORT_NS = "http://www.xoev.de/de/validator/varl/1";
/** Groesster Bericht, der ausgewertet wird (Schutz vor unbegrenztem Speicher). */
export const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_LOCATION = 200;

export type FindingLevel = "FORMAT" | "ERROR" | "WARNING";
export interface Finding {
  ruleId: string;
  level: FindingLevel;
  location: string;
  text: string;
}

export interface ValidatorReport {
  /** Kein Szenario passt zum Profil (z. B. Peppol BIS, ZUGFeRD EXTENDED/BASIC). */
  scenarioMatched: boolean;
  findings: Finding[];
  formatErrors: number;
  ruleErrors: number;
  warnings: number;
}

export class ReportParseError extends Error {
  constructor() {
    super("REPORT_UNREADABLE");
    this.name = "ReportParseError";
  }
}

function truncate(value: string, max: number): string {
  const t = value.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `/Q{uri}Name[1]/Q{uri}Sub[2]` -> `/Name[1]/Sub[2]` */
function shortLocation(xpath: string | null, line: string | null, column: string | null): string {
  if (xpath !== null && xpath !== "") return truncate(xpath.replace(/Q\{[^}]*\}/g, ""), MAX_LOCATION);
  if (line !== null) return `Zeile ${line}${column !== null ? `, Spalte ${column}` : ""}`;
  return "";
}

function elementsNamed(el: XmlElement, local: string): XmlElement[] {
  return el.children.filter((c) => c.namespaceURI === REPORT_NS && c.localName === local);
}

type Assessment = "accept" | "reject";

/**
 * Bewertung des Validators vor dem Abschneiden lesen. Der Namensraumpraefix ist nicht fest, deshalb
 * wird er aus dem Wurzelelement bzw. dem Element selbst gelesen.
 */
function splitAssessment(xml: string): { head: string; assessment: Assessment } {
  const rootPrefix = /<([A-Za-z0-9_-]+):report[\s>]/.exec(xml)?.[1];
  const cut = /<[A-Za-z0-9_-]+:assessment[\s>]/.exec(xml);
  if (!rootPrefix || !cut) throw new ReportParseError();
  const verdict = /^<[A-Za-z0-9_-]+:assessment[^>]*>\s*<[A-Za-z0-9_-]+:(accept|reject)[\s/>]/.exec(xml.slice(cut.index, cut.index + 2_000));
  if (!verdict) throw new ReportParseError();
  return { head: `${xml.slice(0, cut.index)}</${rootPrefix}:report>`, assessment: verdict[1] as Assessment };
}

export function parseValidatorReport(xml: string): ValidatorReport {
  if (xml.length > MAX_REPORT_BYTES) throw new ReportParseError();
  const { head, assessment } = splitAssessment(xml);
  let root: XmlElement;
  try {
    assertSafeXml(head);
    root = parseXmlDom(head);
  } catch {
    throw new ReportParseError();
  }
  if (root.namespaceURI !== REPORT_NS || root.localName !== "report") throw new ReportParseError();
  const matched = elementsNamed(root, "scenarioMatched")[0];
  if (!matched) {
    if (elementsNamed(root, "noScenarioMatched").length === 0) throw new ReportParseError();
    return { scenarioMatched: false, findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 };
  }
  // Bewertung "abgelehnt" oder ungueltiger Schritt ohne gezaehlten Fehler (z. B. Verarbeitungsfehler im Schritt):
  // nie als gueltig melden, sondern als nicht auswertbar behandeln.
  const stepsInvalid = elementsNamed(matched, "validationStepResult").some((st) => st.getAttribute("valid") === "false");
  const all: Finding[] = [];
  let formatErrors = 0;
  let ruleErrors = 0;
  let warnings = 0;
  for (const step of elementsNamed(matched, "validationStepResult")) {
    const stepId = step.getAttribute("id") ?? "";
    // "val-xsd" = Schemapruefung, "val-sch.N" = Schematron-Stufen, "val-xml" = Wohlgeformtheit.
    const isFormat = stepId === "val-xsd" || stepId === "val-xml";
    for (const msg of elementsNamed(step, "message")) {
      const level = msg.getAttribute("level");
      let kind: FindingLevel;
      if (level === "error" || level === "fatal") kind = isFormat ? "FORMAT" : "ERROR";
      else if (level === "warning") kind = "WARNING";
      else continue;
      if (kind === "FORMAT") formatErrors++;
      else if (kind === "ERROR") ruleErrors++;
      else warnings++;
      if (all.length < MAX_FINDINGS * 4) {
        all.push({
          ruleId: truncate(msg.getAttribute("code") ?? "UNKNOWN", 60),
          level: kind,
          location: shortLocation(msg.getAttribute("xpathLocation"), msg.getAttribute("lineNumber"), msg.getAttribute("columnNumber")),
          text: truncate(msg.textContent, MAX_FINDING_TEXT),
        });
      }
    }
  }
  if (formatErrors + ruleErrors === 0 && (assessment === "reject" || root.getAttribute("valid") === "false" || stepsInvalid)) throw new ReportParseError();
  // Fehler vor Warnungen, damit die Kappung auf MAX_FINDINGS nie einen Fehler zugunsten einer Warnung verdraengt.
  const rank: Record<FindingLevel, number> = { FORMAT: 0, ERROR: 1, WARNING: 2 };
  const findings = all.map((f, i) => ({ f, i })).sort((a, b) => rank[a.f.level] - rank[b.f.level] || a.i - b.i).map((x) => x.f).slice(0, MAX_FINDINGS);
  return { scenarioMatched: true, findings, formatErrors, ruleErrors, warnings };
}
