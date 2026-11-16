import { describe, expect, it } from "vitest";
import { parseValidatorReport, ReportParseError } from "@/domain/incoming/validator-report";

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1" xmlns:s="http://www.xoev.de/de/validator/framework/1/scenarios" varlVersion="1.0.0" valid="false"><rep:engine><rep:name>Validator</rep:name></rep:engine>';
const TAIL = '<rep:assessment><rep:reject><rep:explanation><html xmlns="http://www.w3.org/1999/xhtml"><body>Bericht</body></html></rep:explanation></rep:reject></rep:assessment></rep:report>';

function matched(steps: string): string {
  return `${HEAD}<rep:scenarioMatched><s:scenario><s:name>EN16931</s:name></s:scenario>${steps}<rep:validationStepResult id="val-xml" valid="true"/></rep:scenarioMatched>${TAIL}`;
}
const msg = (id: string, level: string, code: string, text: string, loc = '/Q{urn:x}Invoice[1]/Q{urn:x}Line[2]') =>
  `<rep:message id="${id}" level="${level}" xpathLocation="${loc}" code="${code}">${text}</rep:message>`;

describe("Pruefbericht des Validators", () => {
  it("Schemafehler werden zu Formatfehlern, Regelfehler und Warnungen getrennt gezaehlt", () => {
    const xml = matched(
      `<rep:validationStepResult id="val-xsd" valid="false"><rep:message id="val-xsd.1" level="error" lineNumber="6" columnNumber="14" code="cvc-complex-type.2.4.a">Unerwartetes Element</rep:message></rep:validationStepResult>` +
        `<rep:validationStepResult id="val-sch.1" valid="false">${msg("a", "error", "BR-CO-15", "Summe stimmt nicht")}${msg("b", "warning", "BR-CL-21", "Codeliste")}</rep:validationStepResult>`,
    );
    const r = parseValidatorReport(xml);
    expect(r.scenarioMatched).toBe(true);
    expect(r).toMatchObject({ formatErrors: 1, ruleErrors: 1, warnings: 1 });
    expect(r.findings.map((f) => [f.ruleId, f.level])).toEqual([
      ["cvc-complex-type.2.4.a", "FORMAT"],
      ["BR-CO-15", "ERROR"],
      ["BR-CL-21", "WARNING"],
    ]);
    expect(r.findings[0].location).toBe("Zeile 6, Spalte 14");
    expect(r.findings[1].location).toBe("/Invoice[1]/Line[2]");
  });

  it("kein passendes Szenario ist kein Fehler", () => {
    const xml = `${HEAD}<rep:noScenarioMatched><rep:validationStepResult id="val-xml" valid="true"/></rep:noScenarioMatched>${TAIL}`;
    expect(parseValidatorReport(xml)).toEqual({ scenarioMatched: false, findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 });
  });

  it("600 Befunde werden auf 500 gekappt, Zaehler bleiben vollstaendig, Fehler vor Warnungen", () => {
    const warnings = Array.from({ length: 100 }, (_, i) => msg(`w${i}`, "warning", "BR-CL-21", "w")).join("");
    const errors = Array.from({ length: 500 }, (_, i) => msg(`e${i}`, "error", "BR-16", "e")).join("");
    const r = parseValidatorReport(matched(`<rep:validationStepResult id="val-sch.1" valid="false">${warnings}${errors}</rep:validationStepResult>`));
    expect(r.findings).toHaveLength(500);
    expect(r.findings.every((f) => f.level === "ERROR")).toBe(true);
    expect(r).toMatchObject({ ruleErrors: 500, warnings: 100 });
  });

  it("kuerzt lange Texte und Orte, fehlende Regel-Id wird UNKNOWN", () => {
    const long = "x".repeat(900);
    const xml = matched(
      `<rep:validationStepResult id="val-sch.1" valid="false"><rep:message id="m" level="error" xpathLocation="/${"a".repeat(600)}">${long}</rep:message></rep:validationStepResult>`,
    );
    const f = parseValidatorReport(xml).findings[0];
    expect(f.ruleId).toBe("UNKNOWN");
    expect(f.text.length).toBeLessThanOrEqual(500);
    expect(f.location.length).toBeLessThanOrEqual(200);
  });

  it("Stufen ausser Fehler und Warnung werden nicht gezaehlt", () => {
    const r = parseValidatorReport(matched(`<rep:validationStepResult id="val-sch.1" valid="true">${msg("i", "information", "X", "i")}</rep:validationStepResult>`));
    expect(r).toMatchObject({ formatErrors: 0, ruleErrors: 0, warnings: 0, findings: [] });
  });

  it.each([
    ["kein Bericht", "<html/>"],
    ["falscher Namensraum", '<report xmlns="urn:other"><scenarioMatched/></report>'],
    ["weder Szenario noch kein Szenario", `${HEAD}${TAIL}`],
    ["DOCTYPE", `<!DOCTYPE rep [<!ENTITY a "b">]>${matched("")}`],
    ["kaputtes XML", `${HEAD}<rep:scenarioMatched>`],
  ])("unlesbar: %s", (_n, xml) => {
    expect(() => parseValidatorReport(xml)).toThrow(ReportParseError);
  });
});
