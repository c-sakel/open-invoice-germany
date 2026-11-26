/**
 * API-Routen unter src/app/api (ausser v1/, public/, cron/ mit eigener Authentifizierung) fallen ohne Sitzung nie auf
 * einen Platzhalter-Akteur "system" zurueck: ohne Sitzung 401 (Proxy umgangen).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../src/app/api");
const SKIP = new Set(["v1", "public", "cron"]);

function walk(dir: string, top = true): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (top && e.isDirectory() && SKIP.has(e.name)) return [];
    return e.isDirectory() ? walk(path.join(dir, e.name), false) : [path.join(dir, e.name)];
  });
}
const files = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f));

describe("API-Routen ohne Platzhalter-Akteur", () => {
  it("findet die Routendateien", () => {
    expect(files.length).toBeGreaterThan(30);
  });
  it.each(files.map((f) => path.relative(ROOT, f)))("%s enthaelt kein ?? \"system\"", (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    expect(src).not.toMatch(/\?\?\s*["']system["']/);
  });
});
