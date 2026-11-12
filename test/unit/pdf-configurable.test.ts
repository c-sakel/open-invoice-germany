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
  vi.restoreAllMocks();
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

  it("Block subject/intro/outro nicht konfiguriert: Betreff, Einleitung und Fusstext stehen trotzdem im PDF", async () => {
    const data: EInvoiceData = { ...referenzInvoice(), subject: "Betreff Sonderprojekt", consumerRetentionHint: true };
    const bare = await parsePdf(await render(withBlocks(["sender", "recipient", "meta", "lines", "totals", "payment"]), data));
    expect(bare.text).toContain("Betreff Sonderprojekt");
    expect(bare.text).toContain("Wir erlauben uns, folgende Leistungen");
    expect(bare.text).toContain("Vielen Dank für Ihren Auftrag.");
    expect(bare.text).toContain("RE-2073-00042");
    expect(bare.text.replace(/\s+/g, " ")).toContain("zwei Jahre aufzubewahren");
  });
});

describe("Pflichtangaben Leistender (§ 14 Abs. 4 Nr. 2 UStG)", () => {
  const SELLER = "DE123456789";
  const TAX = "12/345/67890";
  const head = (text: string) => text.slice(0, text.indexOf(de.columns.description));

  it("Standard-Fusszeile sichtbar: unveraendert, keine Meta-Zeile mit USt-IdNr im Kopf", async () => {
    const { text } = await parsePdf(await render(presetConfig("standard")));
    expect(head(text)).not.toContain(SELLER);
  });

  it("Fusszeile ausgeblendet: USt-IdNr und Steuernummer stehen in den Meta-Angaben", async () => {
    const { text } = await parsePdf(
      await render(presetConfig("standard"), referenzInvoice(), (t) => {
        t.options = { ...t.options, showFooter: false };
      }),
    );
    expect(text).toContain(SELLER);
    expect(text).toContain(TAX);
  });

  it("footerMode CUSTOM mit Eigentext: beide erscheinen automatisch in den Meta-Angaben", async () => {
    const config = { ...presetConfig("standard"), footer: { ...presetConfig("standard").footer, mode: "CUSTOM" as const } };
    const { text } = await parsePdf(
      await render(config, referenzInvoice(), (t) => {
        t.brand = { ...t.brand, footerLeft: "Eigener Fusstext", footerCenter: "", footerRight: "" };
      }),
    );
    expect(text).toContain("Eigener Fusstext");
    expect(head(text)).toContain(SELLER);
    expect(head(text)).toContain(TAX);
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

describe("Spalten ausblenden und weglassen", () => {
  const discounted = (): EInvoiceData => {
    const base = referenzInvoice();
    return { ...base, lines: base.lines.map((l, i) => (i === 0 ? { ...l, discountCents: 19500, discountPermille: 100 } : l)) };
  };

  it("Design ohne pos und unitPrice rendert ohne NaN", async () => {
    const base = presetConfig("standard");
    const columns = [
      { key: "article" as const, widthPct: 10 },
      { key: "description" as const, widthPct: 58 },
      { key: "qty" as const, widthPct: 16 },
      { key: "total" as const, widthPct: 16 },
    ];
    const pdf = await render({ ...base, columns });
    expect(pdf.toString("latin1")).not.toContain("NaN");
    const { text } = await parsePdf(pdf);
    expect(text).not.toContain("NaN");
    expect(text).toContain("RE-2073-00042");
  });

  it("Rabattspalte nur mit Rabattposition; dann ohne eigene Rabattzeile", async () => {
    captureTexts();
    await render(withColumns({ discount: 8, description: 30 }));
    expect(captured.map((c) => c.text)).not.toContain("Rabatt");
    captureTexts();
    await render(withColumns({ discount: 8, description: 30 }), discounted());
    const texts = captured.map((c) => c.text);
    expect(texts).toContain("Rabatt");
    expect(texts).toContain("10 %");
    expect(texts.some((t) => t.startsWith("abzgl."))).toBe(false);
  });

  it("Festbetrag-Rabatt ohne Prozent: Betrag in der Zelle, keine Doppelung", async () => {
    const base = referenzInvoice();
    const data = { ...base, lines: base.lines.map((l, i) => (i === 0 ? { ...l, discountCents: 5000 } : l)) };
    captureTexts();
    await render(withColumns({ discount: 10, description: 28 }), data);
    const texts = captured.map((c) => c.text);
    expect(texts.filter((t) => t.startsWith("–") && t.includes("50,00"))).toHaveLength(1);
  });

  it("englische Beschriftungen Unit und Discount, Prozent mit Punkt", async () => {
    const base = discounted();
    const line = base.lines[0]!;
    const data: EInvoiceData = { ...base, language: "en", lines: [{ ...line, discountPermille: 125, discountCents: 24375 }, ...base.lines.slice(1)] };
    captureTexts();
    await render(withColumns({ unit: 8, discount: 9, description: 21 }), data);
    const texts = captured.map((c) => c.text);
    expect(texts).toContain("Unit");
    expect(texts).toContain("Discount");
    expect(texts).toContain("12.5 %");
  });

  it("Druckoption blendet USt-Spalte aus: kein Kopf, keine NaN, Breite fuellt die Tabelle", async () => {
    captureTexts();
    const pdf = await render(presetConfig("standard"), referenzInvoice(), (t) => {
      t.options = { ...t.options, showTaxRatePerLine: false, showArticleNumber: false };
    });
    const texts = captured.map((c) => c.text);
    expect(texts).not.toContain("USt");
    expect(texts).not.toContain("Art.-Nr.");
    expect(pdf.toString("latin1")).not.toContain("NaN");
  });
});

describe("Mehrseitiger Beleg", () => {
  it("Umbruch, Summenblock und Zahlungsblock auf den Folgeseiten", async () => {
    const base = referenzInvoice();
    const lines = Array.from({ length: 4 }, (_, k) => base.lines.map((l) => ({ ...l, id: `${l.id}-${k}` }))).flat();
    const net = lines.reduce((s, l) => s + l.lineNetCents, 0);
    const tax = Math.round(net * 0.19);
    const data: EInvoiceData = {
      ...base, lines, netTotalCents: net, taxTotalCents: tax, grossTotalCents: net + tax, payableCents: net + tax, giroAmountCents: net + tax,
      taxSubtotals: [{ taxRate: 19, taxCategory: "S", netCents: net, taxCents: tax }], notes: "Hinweis zur Zahlung.",
    };
    const { text, numpages } = await parsePdf(await render(presetConfig("standard"), data));
    expect(numpages).toBeGreaterThanOrEqual(3);
    expect(text).toContain(de.totals.gross);
    expect(text).toContain("Hinweis zur Zahlung.");
    expect(text.indexOf(de.totals.gross)).toBeLessThan(text.indexOf("Hinweis zur Zahlung."));
  }, 60_000);
});

describe("Fusszeile und Farben", () => {
  const footerXs = async (config: LayoutDesignConfig): Promise<{ tel?: number; iban?: number }> => {
    captureTexts();
    await render(config);
    return {
      tel: captured.find((c) => /^Tel\./.test(c.text))?.x,
      iban: captured.find((c) => /^IBAN /.test(c.text))?.x,
    };
  };

  it("footerColumnCount 1 legt alle Fusszeilenfakten in eine Spalte", async () => {
    const base = presetConfig("standard");
    const one = await footerXs({ ...base, footer: { ...base.footer, columns: 1 } });
    expect(one.tel).toBeDefined();
    expect(one.tel).toBe(one.iban);
    const four = await footerXs({ ...base, footer: { ...base.footer, columns: 4 } });
    expect(four.tel).not.toBe(four.iban);
  });

  it("footerMode CUSTOM zeigt den eigenen Fusstext", async () => {
    const base = presetConfig("standard");
    const config = { ...base, footer: { ...base.footer, mode: "CUSTOM" as const } };
    const { text } = await parsePdf(await render(config, referenzInvoice(), (t) => {
      t.brand = { ...t.brand, footerLeft: "Eigene Fusszeile Links", footerMode: "AUTO" };
    }));
    expect(text).toContain("Eigene Fusszeile Links");
    const auto = await parsePdf(await render(base, referenzInvoice(), (t) => {
      t.brand = { ...t.brand, footerLeft: "Eigene Fusszeile Links", footerMode: "AUTO" };
    }));
    expect(auto.text).not.toContain("Eigene Fusszeile Links");
  });

  it("colors.text wirkt auf Tabellenzellen", async () => {
    const base = presetConfig("standard");
    const tinted = (await render({ ...base, colors: { ...base.colors, text: "#336699" } })).toString("latin1");
    expect(tinted).toContain("0.2 0.4 0.6 scn");
    expect((await render(base)).toString("latin1")).not.toContain("0.2 0.4 0.6 scn");
  });
});

describe("layoutForTheme", () => {
  it("ohne layoutConfig dasselbe Objekt wie getLayout", () => {
    const theme = referenzTheme({ layoutId: "klassik" });
    expect(layoutForTheme(theme)).toBe(getLayout("klassik"));
  });
});
