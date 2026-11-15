import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const roots = ["src/lib/payment", "src/domain/online-payment"].map((r) => path.join(process.cwd(), r));
const all = roots.flatMap(files);

describe("Architektur Online-Zahlung", () => {
  it("hat Quelldateien", () => {
    expect(all.length).toBeGreaterThan(0);
  });
  it("kein direkter Netzzugriff ausser ueber den Transport", () => {
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/(^|[^.\w])fetch\(/);
      expect(src, f).not.toMatch(/node:https?/);
    }
  });
  it("externalRequest nur in transport.ts", () => {
    for (const f of all) {
      if (path.basename(f) === "transport.ts" && f.includes(path.join("lib", "payment"))) continue;
      expect(readFileSync(f, "utf8"), f).not.toContain("externalRequest");
    }
  });
  it("keine Konsolenausgabe mit Schluessel", () => {
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/console\.\w+\(([^)]*)\)/g)) {
        expect(m[1], f).not.toMatch(/apiKey|\bkey\b/i);
      }
    }
  });
});
