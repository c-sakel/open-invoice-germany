/**
 * Phase 16g, Task 1 — Regressions-Hashes der sieben festen Layouts. Sichert, dass der
 * Renderer-Umbau (Designs hinter optionalen PdfLayout-Feldern) die Bestandslayouts byteweise
 * (nach Normalisierung der Zeitstempel/IDs) unveraendert laesst.
 * Fixture neu schreiben: `UPDATE_PDF_REGRESSION=1 npx vitest run test/unit/pdf-regression.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { LAYOUT_IDS, type LayoutId } from "@/lib/pdf/layouts/ids";
import { normalizedPdfHash } from "../helpers/pdf-normalize";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";

const FIXTURE = path.join(process.cwd(), "test/fixtures/pdf-regression.json");

type Case = { key: string; render: () => Promise<Buffer> };

function giroTheme(layoutId: LayoutId) {
  const theme = referenzTheme({ compress: false, layoutId });
  theme.options = { ...theme.options, showGiroCode: true };
  return theme;
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  for (const layoutId of LAYOUT_IDS) {
    const theme = () => referenzTheme({ compress: false, layoutId });
    cases.push({ key: `${layoutId}/invoice`, render: () => renderInvoicePdf(referenzInvoice(), theme()) });
    cases.push({
      key: `${layoutId}/quote`,
      render: () => renderInvoicePdf({ ...referenzInvoice(), type: "ANGEBOT", number: "AN-2073-00007" }, theme()),
    });
    cases.push({
      key: `${layoutId}/credit`,
      render: () => renderInvoicePdf({ ...referenzInvoice(), type: "CREDIT_NOTE" }, theme()),
    });
    cases.push({ key: `${layoutId}/delivery`, render: () => renderDeliveryNotePdf(sampleDeliveryNote(), theme()) });
    cases.push({ key: `${layoutId}/dunning`, render: () => renderDunningPdf(sampleDunning(), theme()) });
  }
  cases.push({
    key: "standard/invoice-en",
    render: () => renderInvoicePdf({ ...referenzInvoice(), language: "en" }, referenzTheme({ compress: false, layoutId: "standard" })),
  });
  cases.push({ key: "standard/invoice-giro", render: () => renderInvoicePdf(referenzInvoice(), giroTheme("standard")) });
  cases.push({ key: "schlicht/invoice-giro", render: () => renderInvoicePdf(referenzInvoice(), giroTheme("schlicht")) });
  return cases;
}

describe("PDF-Regression der festen Layouts", () => {
  const cases = buildCases();

  it("Rendering ist deterministisch (gleicher normalisierter Hash)", async () => {
    const c = cases[0];
    const a = normalizedPdfHash(await c.render());
    await new Promise((resolve) => setTimeout(resolve, 1100)); // Sekundengrenze ueberschreiten
    const b = normalizedPdfHash(await c.render());
    expect(a).toBe(b);
  });

  it("entspricht den gespeicherten Hashes", async () => {
    const actual: Record<string, string> = {};
    for (const c of cases) actual[c.key] = normalizedPdfHash(await c.render());
    const sorted = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (process.env.UPDATE_PDF_REGRESSION === "1") {
      writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + "\n");
      return;
    }
    expect(existsSync(FIXTURE)).toBe(true);
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
    expect(Object.keys(expected)).toHaveLength(38);
    for (const key of Object.keys(sorted)) expect(sorted[key], key).toBe(expected[key]);
  }, 120_000);
});
