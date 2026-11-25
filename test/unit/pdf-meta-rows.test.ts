/**
 * drawMetaRows: Umbruchzweig (Label allein, Wert geschlossen auf der Folgezeile) direkt geprueft.
 */
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import { drawMetaRows } from "@/lib/pdf/layouts/shared";
import type { LayoutFrame } from "@/lib/pdf/layouts/types";

function frameFor(doc: PDFKit.PDFDocument, left: number, right: number): LayoutFrame {
  return {
    doc,
    left,
    right,
    width: right - left,
    primary: "#000",
    base: 10,
    margins: { top: 40, bottom: 40, left, right: 595 - right },
  } as unknown as LayoutFrame;
}

/** Zeichnet die Zeilen und liefert (y vorher, y nachher, gezeichnete Textstuecke). */
function run(rows: { label: string; value: string }[], x = 350, right = 555) {
  const doc = new PDFDocument({ size: "A4", compress: false });
  const drawn: string[] = [];
  const orig = doc.text.bind(doc);
  (doc as unknown as { text: (...a: unknown[]) => unknown }).text = (...a: unknown[]) => {
    if (typeof a[0] === "string") drawn.push(a[0]);
    return (orig as (...b: unknown[]) => unknown)(...a);
  };
  const y = drawMetaRows(frameFor(doc, 40, right), rows, x, 100);
  return { y, drawn, lineHeight: doc.currentLineHeight() };
}

describe("drawMetaRows", () => {
  it("passende Zeile bleibt eine Zeile", () => {
    const r = run([{ label: "Datum", value: "01.01.2262" }]);
    expect(r.drawn).toEqual(["Datum: 01.01.2262"]);
  });

  it("zu langer Wert: Label allein, Wert geschlossen auf der Folgezeile", () => {
    const value = "25.11.2262 – 24.11.2263 und noch ein sehr langer Zusatz";
    const r = run([{ label: "Leistungszeitraum", value }], 450, 555);
    expect(r.drawn).toEqual(["Leistungszeitraum:", value]);
    expect(r.y).toBeGreaterThan(100 + r.lineHeight * 1.5);
  });

  it("Wert mit Zeilenumbruch bleibt unveraendert in einem Aufruf", () => {
    const value = "Zeile eins\nZeile zwei";
    const r = run([{ label: "Anmerkung", value }], 450, 555);
    expect(r.drawn).toEqual([`Anmerkung: ${value}`]);
  });

  it("sehr langer Wert ohne Leerzeichen bricht nicht ab und wirft nicht", () => {
    const value = "X".repeat(400);
    const r = run([{ label: "Referenz", value }], 450, 555);
    expect(r.drawn[0]).toBe("Referenz:");
    expect(r.drawn[1]).toBe(value);
    expect(Number.isFinite(r.y)).toBe(true);
  });
});
