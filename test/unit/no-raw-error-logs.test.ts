/**
 * Statischer Rueckfallschutz: In API-Routen und Server-Actions werden Fehler nur als
 * describeError(e) geloggt, nie als rohes Fehlerobjekt (Prisma-Meldungen koennen
 * IBAN, Mandatsreferenz oder Kartenangaben enthalten).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["src/app/api", "src/app/actions"];
// console.error/warn mit einem bloßen Bezeichner e/err/error als letztem Argument
const RAW_ERROR_LOG = /console\.(?:error|warn)\(([^;]*?),\s*(?:e|err|error)\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("Fehler-Logs in API und Actions", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it("scannt überhaupt Dateien", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("loggt keine rohen Fehlerobjekte als 2. Argument von console.error/warn", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(RAW_ERROR_LOG)) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${relative(ROOT, file)}:${line}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
