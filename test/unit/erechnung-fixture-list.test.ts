/**
 * Phase 18e — die Fixture-Liste des Generators ist die einzige Quelle: Validator-Skript und CI
 * muessen dieselbe Menge pruefen. Kein DB-Zugriff.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

describe("E-Rechnung-Fixture-Liste", () => {
  const listed = execFileSync("npx", ["tsx", "scripts/generate-sample-xrechnung.ts", "--list"], { encoding: "utf8" })
    .trim()
    .split(/\s+/);

  it("entspricht SAMPLE_NAMES im Validator-Skript", () => {
    const src = readFileSync("scripts/validate-erechnung.ts", "utf8");
    const block = /const SAMPLE_NAMES = \[([\s\S]*?)\];/.exec(src);
    expect(block).not.toBeNull();
    const names = [...(block?.[1] ?? "").matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...listed].sort());
  });

  it("enthaelt die Karten- und Lastschrift-Fixtures", () => {
    for (const n of ["karte-54", "lastschrift-59", "card-48", "sepa-59"]) expect(listed).toContain(n);
  });

  it("ci.yml nutzt die Generator-Liste statt einer Handliste", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("generate-sample-xrechnung.ts --list");
    expect(ci).not.toMatch(/SAMPLES="base /);
  });
});
