/**
 * Phase 13b, Task 1 — Strukturtest (kein RTL, vitest environment "node"; Muster:
 * test/unit/dialogs.test.ts). Prueft (1) den Editor-Rahmen laeuft einspaltig,
 * (2) inputCls ist vergroessert und inputDenseCls existiert, (3) die Positionstabelle
 * nutzt ausschliesslich die dichte Klasse, (4) Regression: EditorHeader bleibt sticky.
 *
 * Task 3 ergaenzt zwei weitere Strukturtests: (5) die vier Beleg-Rabattfelder
 * (`documentDiscountPercent/Amount`, `documentChargePercent/Amount`) sind nach dem
 * Verschieben aus `MoreOptions` nur noch in EINER Datei (`DocumentAdjustmentFields.tsx`)
 * als Eingabefeld gebunden (`value={draft.<feld>}`), (6) `LineItemsEditor` traegt den
 * Segmentumschalter (`aria-pressed`, kein `type="checkbox"` mehr fuer "Brutto anzeigen")
 * und den "Produkt auswählen"-Link.
 *
 * Test 5 prueft bewusst NICHT jedes Textvorkommen des Feldnamens (Brief-Vorlage), sondern
 * nur die JSX-Wertbindung `value={draft.<feld>}` — der reine Feldname taucht ausserhalb
 * von `DocumentAdjustmentFields.tsx` schon vorher legitim auf: `RecipientBlock.tsx`
 * uebernimmt beim Kundenwechsel/TakeOver den Rabatt-Default (`dispatch({ ..., field:
 * "documentDiscountPercent", ... })`, `next.documentDiscountAmount = ...`), `TotalsBlock.tsx`
 * erwaehnt ihn nur in einem Kommentar — beides ist bestehende Fachlogik/Doku ausserhalb
 * des Task-3-Dateiumfangs (`MoreOptions`/`LineItemsEditor`/`LineRow`/`DocumentEditor`),
 * keine doppelt gerenderte Eingabe. Die woertliche Textsuche aus der Brief-Vorlage wuerde
 * an diesen zwei Dateien scheitern, ohne dass irgendein Rabattfeld doppelt gerendert wird.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

const EDITOR = path.join(SRC, "components/editor");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Editor-Layout (Phase 13b, Task 1)", () => {
  it("der Editor laeuft einspaltig", () => {
    expect(read("components/editor/DocumentEditor.tsx")).not.toMatch(/md:grid-cols-2/);
  });
  it("inputCls ist groesser, inputDenseCls existiert", () => {
    expect(read("components/forms/fields.tsx")).toMatch(/export const inputCls[\s\S]{0,200}py-2\.5/);
    expect(read("components/forms/fields.tsx")).toMatch(/export const inputDenseCls/);
  });
  it("die Positionstabelle nutzt ausschliesslich die dichte Klasse", () => {
    for (const f of ["blocks/LineRow.tsx", "blocks/LineDiscountField.tsx", "blocks/UnitSelect.tsx"]) {
      const src = read(`components/editor/${f}`);
      expect({ f, dense: /inputDenseCls/.test(src), wide: /\binputCls\b/.test(src) }).toEqual({ f, dense: true, wide: false });
    }
  });
  it("Regression: der Editor-Kopf bleibt sticky (Phase 12a)", () => {
    expect(read("components/editor/blocks/EditorHeader.tsx")).toMatch(/sticky top-0/);
  });
});

describe("Editor-Layout (Phase 13b, Task 3)", () => {
  const files = walk(EDITOR);
  it("die vier Beleg-Rabattfelder sind nur in einer Datei als Eingabefeld gebunden", () => {
    for (const field of ["documentDiscountPercent", "documentDiscountAmount", "documentChargePercent", "documentChargeAmount"]) {
      const needle = `value={draft.${field}}`;
      const hits = files.filter((f) => readFileSync(f, "utf8").includes(needle)).map((f) => path.basename(f));
      expect({ field, hits }).toEqual({ field, hits: ["DocumentAdjustmentFields.tsx"] });
    }
  });
  it("Umschalter und Produktauswahl sitzen in der Positionskopfzeile", () => {
    const src = readFileSync(path.join(EDITOR, "blocks/LineItemsEditor.tsx"), "utf8");
    expect(src).toMatch(/aria-pressed/);
    expect(src).not.toMatch(/type="checkbox"/);
    expect(src).toContain("Produkt auswählen");
  });
});

describe("Unsaved-Guard der Befehlspalette (Phase 13b, Task 7, Backlog 12e)", () => {
  it("ShellProvider exportiert setUnsaved (und einen unsavedRef)", () => {
    const src = readFileSync(path.join(SRC, "components/shell/ShellProvider.tsx"), "utf8");
    expect(src).toMatch(/setUnsaved/);
    expect(src).toMatch(/unsavedRef/);
  });
  it("CommandPalette.go() fragt vor router.push den unsavedRef ab", () => {
    const src = readFileSync(path.join(SRC, "components/shell/CommandPalette.tsx"), "utf8");
    const goFn = src.slice(src.indexOf("function go("), src.indexOf("function onInputKey("));
    expect(goFn).toMatch(/unsavedRef\.current/);
    // "router.push(" (mit Klammer) statt nur "router.push" — der Kommentar direkt ueber
    // der Abfrage erwaehnt "`router.push`" (ohne Klammer) selbst schon vor der Abfrage.
    expect(goFn.indexOf("unsavedRef.current")).toBeLessThan(goFn.indexOf("router.push("));
  });
  it("DocumentEditor meldet draft.dirty an den ShellProvider und raeumt beim Unmount auf", () => {
    const src = readFileSync(path.join(EDITOR, "DocumentEditor.tsx"), "utf8");
    expect(src).toMatch(/setUnsaved\(draft\.dirty\)/);
    expect(src).toMatch(/return \(\) => setUnsaved\(false\)/);
  });
});
