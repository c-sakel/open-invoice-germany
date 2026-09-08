/**
 * Phase 12a, Task 1 — Strukturtest (kein RTL, vitest environment "node"; Muster:
 * test/unit/dockerfile.test.ts). (1) Die Regel, die das Tailwind-v4-Preflight
 * (`*{margin:0}`) fuer `dialog:modal` zuruecknimmt, muss in globals.css stehen.
 * (2) Jedes native <dialog> traegt eine Breitenklasse.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Dialog-Zentrierung (Phase 12a)", () => {
  it("globals.css nimmt das Preflight fuer dialog:modal zurueck", () => {
    const css = readFileSync(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).toMatch(/dialog:modal\s*\{[^}]*margin:\s*auto/);
    expect(css).toMatch(/dialog:modal\s*\{[^}]*max-height:\s*calc\(100dvh - 2rem\)/);
    expect(css).toMatch(/dialog:modal\s*\{[^}]*max-width:\s*calc\(100vw - 2rem\)/);
  });

  it("jedes <dialog> traegt w-full und eine max-w-Klasse", () => {
    // Kommentare (Modul-JSDoc, Zeilenkommentare) erwaehnen `<dialog>` haeufig in
    // Prosa (z. B. "natives <dialog>," oder "`<dialog>`") — ohne Bereinigung liest
    // die Regex das als Tag und der lazy-Abschluss `[\s\S]{0,400}?>` schnappt sich
    // das naechstbeste `>` (auch aus `=>` oder echtem Markup weiter unten) statt
    // eines echten JSX-Tags. Kommentare vorab entfernen, damit nur reale <dialog>-
    // Elemente geprueft werden.
    function stripComments(src: string): string {
      return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    }
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/<dialog\b[\s\S]{0,400}?>/g)) {
        const tag = m[0];
        if (!/className="[^"]*\bw-full\b/.test(tag) || !/className="[^"]*\bmax-w-/.test(tag)) {
          offenders.push(`${path.relative(SRC, file)}: ${tag.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
