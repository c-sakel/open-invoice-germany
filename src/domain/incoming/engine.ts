/**
 * Pruefmaschine fuer eingehende E-Rechnungen: der offizielle Validator (Schema, EN 16931,
 * XRechnung) laeuft als eigener Prozess mit zugeschnittener Java-Laufzeit. Der Prozess bekommt nur
 * eine Arbeitsdatei in einem frischen Verzeichnis, hat keine Umgebungsvariablen der Anwendung,
 * Speicher- und Zeitgrenze und wird bei Zeitablauf beendet. Pro Rechnung ein Prozess; Aufrufer
 * serialisieren ueber `runExclusive` in validate.ts.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VALIDATE_TIMEOUT_MS } from "./limits";
import { parseValidatorReport, ReportParseError, type Finding } from "./validator-report";

export type NotCheckedReason =
  | "TIMEOUT"
  | "OUT_OF_MEMORY"
  | "ENGINE_OFF"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_ERROR"
  | "PROFILE_NOT_COVERED"
  | "TOO_MANY_LINES";

export type EngineOutcome =
  | { findings: Finding[]; formatErrors: number; ruleErrors: number; warnings: number }
  | { notChecked: NotCheckedReason };

export interface ValidationEngine {
  readonly id: string;
  readonly artefactVersion: string;
  run(xml: string, opts?: { timeoutMs?: number }): Promise<EngineOutcome>;
}

/** Keine Umgebungsvariablen der Anwendung (Schluessel, Datenbank) an den Kindprozess (NODE_ENV nur wegen des Typs). */
const CHILD_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "production" };
const DEFAULT_DIR = "/opt/validator";
const DEFAULT_JAVA = "/opt/jre/bin/java";
/** Speicher der Java-Laufzeit; der Validator braucht fuer 5.000 Positionen rund 340-590 MB Gesamtspeicher. */
const JAVA_ARGS = ["-Xmx384m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-XX:+ExitOnOutOfMemoryError", "-Dfile.encoding=UTF-8"];

type Env = Readonly<Record<string, string | undefined>>;

function validatorDir(env: Env): string {
  return env.EINVOICE_VALIDATOR_DIR || DEFAULT_DIR;
}

function javaBinary(env: Env): string {
  if (env.EINVOICE_JAVA) return env.EINVOICE_JAVA;
  return existsSync(DEFAULT_JAVA) ? DEFAULT_JAVA : "java";
}

function artefactVersionOf(dir: string): string {
  try {
    const v: unknown = JSON.parse(readFileSync(path.join(dir, "VERSION.json"), "utf8"));
    if (typeof v === "object" && v !== null) {
      const o = v as { validator?: unknown; configuration?: unknown };
      if (typeof o.validator === "string" && typeof o.configuration === "string") return `validator-${o.validator}+${o.configuration}`.slice(0, 200);
    }
  } catch {
    // Kennung bleibt unbekannt.
  }
  return "unknown";
}

const OFF_ENGINE: ValidationEngine = {
  id: "off",
  artefactVersion: "-",
  run: () => Promise.resolve({ notChecked: "ENGINE_OFF" }),
};

const UNAVAILABLE_ENGINE: ValidationEngine = {
  id: "none",
  artefactVersion: "-",
  run: () => Promise.resolve({ notChecked: "ENGINE_UNAVAILABLE" }),
};

/** Ergebnis des Kindprozesses ohne Bericht: Zeit, Speicher oder sonstiger Fehler. */
function classifyFailure(output: string): NotCheckedReason {
  if (/OutOfMemoryError/.test(output)) return "OUT_OF_MEMORY";
  return "ENGINE_ERROR";
}

function kositEngine(dir: string, java: string): ValidationEngine {
  const jar = path.join(dir, "validator.jar");
  const configDir = path.join(dir, "config");
  const scenarios = path.join(configDir, "scenarios.xml");
  return {
    id: "kosit-validator",
    artefactVersion: artefactVersionOf(dir),
    async run(xml, opts) {
      const work = await mkdtemp(path.join(os.tmpdir(), "oig-validate-"));
      try {
        const input = path.join(work, "invoice.xml");
        await writeFile(input, xml, { encoding: "utf8", mode: 0o600 });
        const args = [...JAVA_ARGS, `-Djava.io.tmpdir=${work}`, "-jar", jar, "-s", scenarios, "-r", configDir, "-o", work, input];
        const done = await new Promise<{ err: (Error & { killed?: boolean; signal?: string | null }) | null; output: string }>((resolve) => {
          execFile(
            java,
            args,
            { timeout: opts?.timeoutMs ?? VALIDATE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: CHILD_ENV, cwd: work, windowsHide: true },
            (err, stdout, stderr) => resolve({ err, output: `${stdout}\n${stderr}`.slice(0, 20_000) }),
          );
        });
        let reportText: string | null = null;
        try {
          reportText = await readFile(path.join(work, "invoice-report.xml"), "utf8");
        } catch {
          // Kein Bericht: Zeit/Speicher/Fehler weiter unten.
        }
        // Rueckgabecode 1 heisst "abgelehnt" und ist kein Fehler; ein Bericht ist massgeblich, ausser der Prozess wurde beendet.
        if (done.err?.killed === true) return { notChecked: "TIMEOUT" };
        if (reportText === null) return { notChecked: classifyFailure(done.output) };
        try {
          const report = parseValidatorReport(reportText);
          if (!report.scenarioMatched) return { notChecked: "PROFILE_NOT_COVERED" };
          return { findings: report.findings, formatErrors: report.formatErrors, ruleErrors: report.ruleErrors, warnings: report.warnings };
        } catch (e) {
          if (e instanceof ReportParseError) return { notChecked: "ENGINE_ERROR" };
          throw e;
        }
      } catch {
        return { notChecked: "ENGINE_ERROR" };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * `INCOMING_VALIDATION=off` schaltet die Pruefung ab (NOT_CHECKED/ENGINE_OFF). Ohne abgelegten Validator
 * (kein Image, keine lokalen Artefakte) ist die Pruefung nicht verfuegbar (NOT_CHECKED/ENGINE_UNAVAILABLE);
 * die Annahme bleibt in jedem Fall unberuehrt.
 */
export function selectEngine(env: Env = process.env): ValidationEngine {
  if (env.INCOMING_VALIDATION === "off") return OFF_ENGINE;
  const dir = validatorDir(env);
  if (!existsSync(path.join(dir, "validator.jar")) || !existsSync(path.join(dir, "config", "scenarios.xml"))) return UNAVAILABLE_ENGINE;
  return kositEngine(dir, javaBinary(env));
}
