/**
 * Phase 16a, Task 8 — Betriebsskripte: Syntax und Eingabepruefung (ohne Datenbank/Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BACKUP = path.resolve("scripts/ops/backup.sh");
const RESTORE = path.resolve("scripts/ops/restore-test.sh");

let dir: string;
let pass600: string;
let pass644: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "oig-ops-"));
  pass600 = path.join(dir, "p600");
  pass644 = path.join(dir, "p644");
  writeFileSync(pass600, "geheim\n");
  chmodSync(pass600, 0o600);
  writeFileSync(pass644, "geheim\n");
  chmodSync(pass644, 0o644);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, env: Record<string, string>, args: string[] = []) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("BACKUP_") || k === "DATABASE_URL") delete base[k];
  return spawnSync("bash", [script, ...args], { env: { ...base, ...env }, encoding: "utf8" });
}
function lastLine(out: string): string {
  return out.trim().split("\n").pop() ?? "";
}

describe("Betriebsskripte", () => {
  it.each([BACKUP, RESTORE])("bash -n %s Exit 0", (script) => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("backup.sh: unbekanntes Ziel ftp:x -> FEHLER, Exit != 0", () => {
    const r = run(BACKUP, { BACKUP_PASSPHRASE_FILE: pass600, BACKUP_TARGET: "ftp:x", DATABASE_URL: "postgresql://x" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
  });

  it("backup.sh: Passphrasen-Datei Modus 644 -> FEHLER, Exit != 0", () => {
    const r = run(BACKUP, { BACKUP_PASSPHRASE_FILE: pass644, DATABASE_URL: "postgresql://x" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER .*600/);
  });

  it("backup.sh: fehlende Passphrasen-Datei -> FEHLER und Status-Zeile", () => {
    const status = path.join(dir, "status.txt");
    const r = run(BACKUP, { BACKUP_STATUS_FILE: status, DATABASE_URL: "postgresql://x" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
    const written = spawnSync("cat", [status], { encoding: "utf8" }).stdout;
    expect(written).toMatch(/^FEHLER \d{4}-\d{2}-\d{2}T/);
  });

  it("backup.sh: BACKUP_KEEP_REMOTE keine Ganzzahl -> FEHLER", () => {
    const r = run(BACKUP, { BACKUP_PASSPHRASE_FILE: pass600, DATABASE_URL: "postgresql://x", BACKUP_KEEP_REMOTE: "1; rm -rf /" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER .*Ganzzahl/);
  });

  it("backup.sh: nutzt --no-owner/--no-privileges, kein Passwort in argv", () => {
    const src = readFileSync(BACKUP, "utf8");
    expect(src).toContain("pg_dump --no-owner --no-privileges \"$PG_URL\"");
    expect(src).toContain("umask 077");
    expect(src).not.toMatch(/pg_dump[^\n]*\$DATABASE_URL/);
  });

  it("restore-test.sh: ohne Argument -> FEHLER", () => {
    const r = run(RESTORE, { BACKUP_PASSPHRASE_FILE: pass600 });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.stdout)).toMatch(/^FEHLER /);
  });
});
