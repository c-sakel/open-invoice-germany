import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function block(source: string, startPattern: RegExp): string {
  const m = startPattern.exec(source);
  if (!m) throw new Error(`Block nicht gefunden: ${startPattern}`);
  let depth = 0;
  const open = source.indexOf("{", m.index);
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("Block nicht geschlossen");
}

function hexTokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const light = hexTokens(block(css, /@theme\s*\{/));
const dark = hexTokens(block(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/));

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ["ink", "ink-soft", "ink-muted", "pen", "stamp", "seal", "ledger"];
const GRAPHIC = ["pen", "seal", "stamp", "ledger", "ink-muted"];

describe("Design-Tokens", () => {
  it("Text-Token hell ≥ 4,5 gegen sheet/paper", () => {
    for (const bg of ["#ffffff", "#fbfaf7"]) {
      for (const t of TEXT) expect(contrast(light[t], bg), `${t} auf ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("Text-Token dunkel ≥ 4,5 gegen sheet/paper/sheet-raised", () => {
    for (const bg of ["#1b1f27", "#14171d", "#222733"]) {
      for (const t of TEXT) expect(contrast(dark[t], bg), `${t} auf ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("Diagramm-Token ≥ 3 gegen sheet", () => {
    for (const t of GRAPHIC) {
      expect(contrast(light[t], "#ffffff"), `${t} hell`).toBeGreaterThanOrEqual(3);
      expect(contrast(dark[t], "#1b1f27"), `${t} dunkel`).toBeGreaterThanOrEqual(3);
    }
  });

  it("Fokusregel in @layer base", () => {
    const base = block(css, /@layer\s+base\s*\{/);
    expect(base).toContain(":focus-visible");
    expect(base).toMatch(/outline:\s*2px solid var\(--color-focus\)/);
    expect(base).toMatch(/outline-offset:\s*2px/);
  });

  it("kein @theme inline", () => {
    expect(css).not.toMatch(/@theme\s+inline/);
  });
});
