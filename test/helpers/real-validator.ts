/**
 * Findet den echten Validator fuer Integrationstests: Ordner aus EINVOICE_VALIDATOR_DIR oder dem lokalen Cache
 * (scripts/fetch-einvoice-validator.sh validation/.cache/einvoice-validator) und eine Java-Laufzeit ab Version 17
 * (EINVOICE_JAVA oder `java` im Pfad). Fehlt eines davon, liefert der Helfer null und die Tests ueberspringen sich;
 * in CI (`CI` gesetzt) ist das ein Fehler, damit ein fehlgeschlagener Abruf nicht still zu null Rundlauftests fuehrt.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { selectEngine, type ValidationEngine } from "@/domain/incoming/engine";

function javaMajor(java: string): number | null {
  const r = spawnSync(java, ["-version"], { encoding: "utf8", timeout: 60_000 });
  return parseMajor(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
}

function parseMajor(text: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return m[1] === "1" ? Number(m[2]) : Number(m[1]);
}

export function realValidatorEngine(): ValidationEngine | null {
  const engine = findRealValidatorEngine();
  if (engine === null && process.env.CI) {
    throw new Error("Validator oder Java ab 17 fehlt in CI (scripts/fetch-einvoice-validator.sh und setup-java pruefen)");
  }
  return engine;
}

function findRealValidatorEngine(): ValidationEngine | null {
  const dir = process.env.EINVOICE_VALIDATOR_DIR || path.resolve(process.cwd(), "validation/.cache/einvoice-validator");
  if (!existsSync(path.join(dir, "validator.jar"))) return null;
  const java = process.env.EINVOICE_JAVA || "java";
  const major = javaMajor(java);
  if (major === null || major < 17) return null;
  const engine = selectEngine({ ...process.env, EINVOICE_VALIDATOR_DIR: dir, EINVOICE_JAVA: java });
  return engine.id === "kosit-validator" ? engine : null;
}
