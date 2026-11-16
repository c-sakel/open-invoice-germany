/**
 * Pruefmaschine: Kindprozess, Zeitgrenze, Speicher, Umgebung. Statt Java laeuft ein Shell-Skript, das den
 * Aufruf des Validators nachbildet (-o <Ordner> ... <Datei>); so laufen die Tests auch ohne Java.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectEngine } from "@/domain/incoming/engine";

const REPORT_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1" valid="false"><rep:engine><rep:name>V</rep:name></rep:engine>';
const REJECT = '<rep:assessment><rep:reject/></rep:assessment></rep:report>';

let dir = "";
const envFile = () => path.join(dir, "child-env.txt");

function fakeJava(body: string): string {
  const p = path.join(dir, "java");
  // Argumentschema wie beim echten Aufruf: ... -o <Ordner> <Eingabedatei>
  writeFileSync(
    p,
    `#!/bin/sh
out=""; prev=""; last=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"; last="$a"
done
env > "${envFile()}"
${body}
`,
  );
  chmodSync(p, 0o755);
  return p;
}

function engineWith(body: string, extra: Record<string, string | undefined> = {}) {
  return selectEngine({ ...process.env, EINVOICE_VALIDATOR_DIR: dir, EINVOICE_JAVA: fakeJava(body), ...extra });
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
  mkdirSync(path.join(dir, "config"));
  writeFileSync(path.join(dir, "validator.jar"), "x");
  writeFileSync(path.join(dir, "config", "scenarios.xml"), "<s/>");
  writeFileSync(path.join(dir, "VERSION.json"), JSON.stringify({ validator: "9.9.9", configuration: "cfg-1" }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Pruefmaschine (Kindprozess)", () => {
  it("liest den Bericht, auch wenn der Prozess mit Code 1 (abgelehnt) endet", async () => {
    const report = `${REPORT_HEAD}<rep:scenarioMatched><rep:validationStepResult id="val-sch.1" valid="false"><rep:message id="m" level="error" code="BR-16">Positionen fehlen</rep:message></rep:validationStepResult></rep:scenarioMatched>${REJECT}`;
    const e = engineWith(`cat > "$out/invoice-report.xml" <<'EOF2'\n${report}\nEOF2\nexit 1`);
    expect(e.artefactVersion).toBe("validator-9.9.9+cfg-1");
    const r = await e.run("<Invoice/>");
    expect(r).toMatchObject({ ruleErrors: 1, formatErrors: 0, warnings: 0 });
    expect("findings" in r && r.findings[0].ruleId).toBe("BR-16");
  });

  it("gibt die Eingabedatei weiter und keine Umgebungsvariablen der Anwendung", async () => {
    process.env.AUTH_SECRET = "geheim-fuer-test-1234567890";
    process.env.DATABASE_URL = "postgres://example.org/geheim";
    const e = engineWith(
      `cp "$last" "${path.join(dir, "seen-input.xml")}"\ncat > "$out/invoice-report.xml" <<'EOF2'\n${REPORT_HEAD}<rep:scenarioMatched/>${REJECT}\nEOF2`,
    );
    await e.run("<Invoice>fiktiv</Invoice>");
    expect(readFileSync(path.join(dir, "seen-input.xml"), "utf8")).toBe("<Invoice>fiktiv</Invoice>");
    const env = readFileSync(envFile(), "utf8");
    expect(env).not.toContain("AUTH_SECRET");
    expect(env).not.toContain("DATABASE_URL");
    delete process.env.AUTH_SECRET;
    delete process.env.DATABASE_URL;
  });

  it("kein passendes Szenario -> PROFILE_NOT_COVERED", async () => {
    const e = engineWith(`cat > "$out/invoice-report.xml" <<'EOF2'\n${REPORT_HEAD}<rep:noScenarioMatched/>${REJECT}\nEOF2\nexit 1`);
    expect(await e.run("<Invoice/>")).toEqual({ notChecked: "PROFILE_NOT_COVERED" });
  });

  it("Zeitgrenze beendet den Prozess -> TIMEOUT, die Anwendung laeuft weiter", async () => {
    const e = engineWith("exec sleep 30");
    const started = Date.now();
    expect(await e.run("<Invoice/>", { timeoutMs: 300 })).toEqual({ notChecked: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("Speichererschoepfung der Laufzeit -> OUT_OF_MEMORY", async () => {
    const e = engineWith('echo "Exception in thread main java.lang.OutOfMemoryError: Java heap space" >&2\nexit 3');
    expect(await e.run("<Invoice/>")).toEqual({ notChecked: "OUT_OF_MEMORY" });
  });

  it("Prozessfehler ohne Bericht und unlesbarer Bericht -> ENGINE_ERROR", async () => {
    expect(await engineWith("exit 2").run("<Invoice/>")).toEqual({ notChecked: "ENGINE_ERROR" });
    expect(await engineWith(`echo "<kaputt" > "$out/invoice-report.xml"`).run("<Invoice/>")).toEqual({ notChecked: "ENGINE_ERROR" });
    expect(await selectEngine({ ...process.env, EINVOICE_VALIDATOR_DIR: dir, EINVOICE_JAVA: path.join(dir, "gibt-es-nicht") }).run("<Invoice/>")).toEqual({
      notChecked: "ENGINE_ERROR",
    });
  });

  it("raeumt das Arbeitsverzeichnis auf", async () => {
    const before = new Set(readdirTmp());
    await engineWith("exit 2").run("<Invoice/>");
    expect(readdirTmp().filter((n) => !before.has(n))).toEqual([]);
  });

  it("INCOMING_VALIDATION=off und fehlender Validator melden feste Gruende", async () => {
    expect(await selectEngine({ ...process.env, INCOMING_VALIDATION: "off" }).run("<Invoice/>")).toEqual({ notChecked: "ENGINE_OFF" });
    expect(await selectEngine({ ...process.env, EINVOICE_VALIDATOR_DIR: path.join(dir, "leer") }).run("<Invoice/>")).toEqual({ notChecked: "ENGINE_UNAVAILABLE" });
  });
});

function readdirTmp(): string[] {
  return readdirSync(os.tmpdir()).filter((n) => n.startsWith("oig-validate-"));
}
