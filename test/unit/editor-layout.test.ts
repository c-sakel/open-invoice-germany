/**
 * Phase 13b, Task 1 — Strukturtest (kein RTL, vitest environment "node"; Muster:
 * test/unit/dialogs.test.ts). Prueft (1) den Editor-Rahmen laeuft einspaltig,
 * (2) inputCls ist vergroessert und inputDenseCls existiert, (3) die Positionstabelle
 * nutzt ausschliesslich die dichte Klasse, (4) Regression: EditorHeader bleibt sticky.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

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
