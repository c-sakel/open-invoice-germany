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
const all = files(path.join(process.cwd(), "src")).filter((f) => !f.includes(`${path.sep}generated${path.sep}`));
const TRANSPORT = path.join("src", "lib", "payment", "transport.ts");
const EXTERNAL = path.join("src", "lib", "http", "external.ts");
const isPayment = (f: string) =>
  f.includes(path.join("src", "lib", "payment") + path.sep) || /src[\\/]domain[\\/].*payment/i.test(f);

describe("Architektur Online-Zahlung", () => {
  it("hat Quelldateien", () => {
    expect(all.filter(isPayment).length).toBeGreaterThan(0);
  });
  it("Anbieter-Code ruft das Netz nie direkt auf", () => {
    for (const f of all.filter(isPayment)) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bfetch\s*\(/);
      expect(src, f).not.toMatch(/globalThis\.fetch|window\.fetch|\bXMLHttpRequest\b|\bWebSocket\b/);
      expect(src, f).not.toMatch(/from\s+["'](node:)?(https?|net|tls|http2|undici)["']|require\(\s*["'](node:)?(https?|net|tls|undici)["']/);
    }
  });
  it("externalRequest nur in transport.ts und external.ts (ganz src)", () => {
    for (const f of all) {
      const rel = path.relative(process.cwd(), f);
      if (rel === TRANSPORT || rel === EXTERNAL) continue;
      expect(readFileSync(f, "utf8"), f).not.toContain("externalRequest");
    }
  });
  it("Stripe-Code ohne Netz, SDK und Schluessel-Ausgabe; Adresse nur im Adapter", () => {
    const stripeFiles = all.filter((f) => /src[\\/]lib[\\/]payment[\\/](stripe[^\\/]*|form-encode)\.ts$/.test(f));
    expect(stripeFiles.length).toBe(3);
    for (const f of stripeFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bfetch\s*\(|node:https|from\s+["']stripe["']|console\./);
    }
    for (const f of all) {
      const rel = path.relative(process.cwd(), f);
      if (rel === path.join("src", "lib", "payment", "stripe.ts")) continue;
      expect(readFileSync(f, "utf8"), f).not.toContain("api.stripe.com");
    }
  });
  it("keine Konsolenausgabe mit Schluessel", () => {
    for (const f of all.filter(isPayment)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/console\.\w+\(([^)]*)\)/g)) {
        expect(m[1], f).not.toMatch(/apiKey|\bkey\b/i);
      }
    }
  });
});
