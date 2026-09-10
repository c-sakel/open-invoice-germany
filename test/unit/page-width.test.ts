/**
 * Phase 13a, Task 1 — Strukturtest (kein RTL, vitest environment "node"; Muster:
 * test/unit/dialogs.test.ts). `AppShell` gibt seit dieser Phase 1600px Breite frei
 * (gewollt fuer Listen/Editor/Belegansicht); `PageContainer` schnuert Stammdaten-/
 * Einstellungsformulare wieder auf eine lesbare Zeilenlaenge ein.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");

describe("Seitenbreite (Phase 13a, Task 1)", () => {
  it("AppShell nutzt kein max-w-6xl mehr, sondern genau zweimal max-w-[1600px] (main + footer)", () => {
    const code = readFileSync(path.join(SRC, "components/shell/AppShell.tsx"), "utf8");
    expect(code).not.toMatch(/max-w-6xl/);
    const hits = code.match(/max-w-\[1600px\]/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it("PageContainer begrenzt Formularseiten auf max-w-4xl und ist eine Server-Komponente", () => {
    const code = readFileSync(path.join(SRC, "components/PageContainer.tsx"), "utf8");
    expect(code).toMatch(/max-w-4xl/);
    expect(code).not.toMatch(/"use client"/);
  });

  it("app/einstellungen/layout.tsx existiert und huellt seine Kinder in PageContainer width=\"form\"", () => {
    const file = path.join(SRC, "app/einstellungen/layout.tsx");
    expect(existsSync(file)).toBe(true);
    const code = readFileSync(file, "utf8");
    expect(code).toMatch(/PageContainer[\s\S]*width="form"/);
  });
});
