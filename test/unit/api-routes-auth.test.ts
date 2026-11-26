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

  // Routen, deren Domain-Funktionen sonst auf den Akteur "system" zurueckfielen.
  const ACTOR_ROUTES = [
    "api-keys/route.ts",
    "api-keys/[id]/route.ts",
    "documents/route.ts",
    "documents/[id]/take-over-prefill/route.ts",
    "invoices/route.ts",
    "invoices/[id]/cancel/route.ts",
    "invoices/[id]/credit/route.ts",
    "invoices/[id]/finalize/route.ts",
    "invoices/[id]/payment/route.ts",
    "invoices/[id]/payment/[pid]/reverse/route.ts",
    "recurring/[id]/run/route.ts",
  ];
  it.each(ACTOR_ROUTES)("%s verlangt eine Sitzung und reicht den Akteur weiter", (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    expect(src).toMatch(/await requireSessionActor\(\)/);
    expect(src).toMatch(/AuthRequiredError/);
    expect(src).not.toMatch(/actor:\s*["'](user|session|system)["']/);
  });
});
