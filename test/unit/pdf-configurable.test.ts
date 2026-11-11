/**
 * Phase 16g, Task 4 — konfigurierbares Layout im Rechnungs-Renderer: Bloecke, Spalten, Schrift,
 * Raender, Determinismus. Testjahr 2073 (Referenzfixture).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import PDFDocument from "pdfkit";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { getLayout, layoutForTheme } from "@/lib/pdf/layouts/registry";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { docStrings } from "@/lib/i18n/doc";
import type { LayoutBlockKey, LayoutColumnKey, LayoutDesignConfig } from "@/schemas/layout-design";
import type { EInvoiceData } from "@/lib/einvoice/types";
import { normalizedPdfHash } from "../helpers/pdf-normalize";
import { parsePdf } from "../helpers/pdf-theme";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";

const de = docStrings("de");
const BLOCKS_BASE: LayoutBlockKey[] = ["sender", "recipient", "meta", "subject", "intro", "lines", "totals", "outro", "payment"];

function withBlocks(blocks: LayoutBlockKey[]): LayoutDesignConfig {
  return { ...presetConfig("standard"), blocks };
}
function withColumns(add: Partial<Record<LayoutColumnKey, number>>): LayoutDesignConfig {
  const base = presetConfig("standard");
  const widths: Record<string, number> = { pos: 6, article: 10, description: 38, qty: 10, unitPrice: 13, taxRate: 7, total: 16, ...add };
  const keys: LayoutColumnKey[] = ["pos", "article", "description", "qty", "unit", "unitPrice", "taxRate", "discount", "total"];
  return { ...base, columns: keys.filter((k) => widths[k] !== undefined).map((key) => ({ key, widthPct: widths[key]! })) };
}
async function render(config: LayoutDesignConfig, data: EInvoiceData = referenzInvoice(), tweak?: (t: ReturnType<typeof referenzTheme>) => void) {
  const theme = referenzTheme({ compress: false, layoutConfig: config });
  tweak?.(theme);
  return renderInvoicePdf(data, theme);
}

type TextCall = { text: string; x: number | undefined };
const captured: TextCall[] = [];
function captureTexts(): void {
  captured.length = 0;
  const original = PDFDocument.prototype.text;
  vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
    captured.push({ text: String(args[0]), x: typeof args[1] === "number" ? args[1] : undefined });
    return (original as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
  });
}
afterEach(() => vi.restoreAllMocks());

describe("Determinismus", () => {
  it("gleiche Konfiguration -> gleicher Hash, andere Primaerfarbe -> anderer", async () => {
    const a = normalizedPdfHash(await render(presetConfig("standard")));
    const b = normalizedPdfHash(await render(presetConfig("standard")));
    expect(a).toBe(b);
    const other = presetConfig("standard");
    other.colors = { ...other.colors, primary: "#c0392b" };
    expect(normalizedPdfHash(await render(other))).not.toBe(a);
  }, 60_000);
});

describe("Bloecke", () => {
  it("outro vor totals: Fusstext steht vor dem Bruttolabel", async () => {
    const { text } = await parsePdf(await render(withBlocks(["sender", "recipient", "meta", "subject", "intro", "lines", "outro", "totals", "payment"])));
    const outro = text.indexOf("Vielen Dank für Ihren Auftrag.");
    expect(outro).toBeGreaterThan(-1);
    expect(outro).toBeLessThan(text.indexOf(de.totals.gross));
  });

  it("giro direkt nach totals: GiroCode-Unterschrift vor dem Fusstext", async () => {
    const { text } = await parsePdf(await render(withBlocks(["sender", "recipient", "meta", "subject", "intro", "lines", "totals", "giro", "outro", "payment"])));
    const caption = text.indexOf(de.giro.captionShort);
    expect(caption).toBeGreaterThan(-1);
    expect(caption).toBeLessThan(text.indexOf("Vielen Dank für Ihren Auftrag."));
  });

  it("ohne subject: Betreff fehlt, Rechnungsnummer und Pflichthinweise bleiben", async () => {
    const data: EInvoiceData = { ...referenzInvoice(), subject: "Betreff Sonderprojekt", consumerRetentionHint: true };
    const without = await parsePdf(await render(withBlocks(["sender", "recipient", "meta", "intro", "lines", "totals", "outro", "payment"]), data));
    expect(without.text).not.toContain("Betreff Sonderprojekt");
    expect(without.text).toContain("RE-2073-00042");
    expect(without.text.replace(/\s+/g, " ")).toContain("zwei Jahre aufzubewahren");
    const withSubject = await parsePdf(await render(withBlocks(BLOCKS_BASE), data));
    expect(withSubject.text).toContain("Betreff Sonderprojekt");
  });
});

describe("Spalten", () => {
  const oneLine = (extra: Partial<EInvoiceData["lines"][number]> = {}): EInvoiceData => {
    const base = referenzInvoice();
    const line = { ...base.lines[0]!, descriptionLong: undefined, ...extra };
    return { ...base, lines: [line] };
  };

  it("mit unit: Kopf Einheit, Mengenzelle ohne Einheit", async () => {
    captureTexts();
    await render(withColumns({ unit: 8, description: 30 }), oneLine());
    const texts = captured.map((c) => c.text);
    expect(texts).toContain("Einheit");
    expect(texts).toContain("Std");
    expect(texts.some((t) => /^[\d.,]+ Std$/.test(t))).toBe(false);
  });

  it("mit discount: 10 % in der Zeile, keine eigene Rabattzeile", async () => {
    captureTexts();
    await render(withColumns({ discount: 8, description: 30 }), oneLine({ discountCents: 19500, discountPermille: 100 }));
    const texts = captured.map((c) => c.text);
    expect(texts).toContain("10 %");
    expect(texts).toContain("Rabatt");
    expect(texts).not.toContain(de.totals.lineDiscount(" 10 %"));
  });

  it("showLineTotals aus: kein Netto-Kopf", async () => {
    captureTexts();
    await render(presetConfig("standard"), referenzInvoice(), (t) => {
      t.options = { ...t.options, showLineTotals: false };
    });
    expect(captured.map((c) => c.text)).not.toContain("Netto");
  });
});

describe("Schrift und Raender", () => {
  it("ibm-plex-serif wird eingebettet", async () => {
    const pdf = await render({ ...presetConfig("standard"), font: "ibm-plex-serif" });
    expect(pdf.toString("latin1")).toMatch(/\/BaseFont \/[A-Z]{6}\+IBMPlexSerif/);
  });

  it("linker Rand 25 mm: kein Text links von 70,8 pt", async () => {
    captureTexts();
    const base = presetConfig("standard");
    await render({ ...base, marginsMm: { ...base.marginsMm, left: 25 } }, referenzInvoice(), (t) => {
      t.options = { ...t.options, showPageNumbers: false };
    });
    const xs = captured.map((c) => c.x).filter((x): x is number => x !== undefined && x > 0);
    expect(xs.length).toBeGreaterThan(10);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(70.8);
  });
});

describe("layoutForTheme", () => {
  it("ohne layoutConfig dasselbe Objekt wie getLayout", () => {
    const theme = referenzTheme({ layoutId: "klassik" });
    expect(layoutForTheme(theme)).toBe(getLayout("klassik"));
  });
});
