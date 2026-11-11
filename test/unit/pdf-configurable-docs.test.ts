/**
 * Phase 16g, Task 5 — Lieferschein und Mahnung mit Design-Konfiguration: Schrift, Spalten,
 * Preise per Druckoption, DIN-5008-Fenster im Mahnungs-Kopf. Reine Renderer-Tests ohne DB.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderDeliveryNotePdf, type DeliveryNotePdfData } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { buildSampleDeliveryNoteData, buildSampleDunningData } from "@/domain/settings/preview";
import { docStrings } from "@/lib/i18n/doc";
import { senderLineFallback } from "@/lib/pdf/layout";
import type { LayoutColumnKey, LayoutDesignConfig } from "@/schemas/layout-design";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";
import { recordTextBoxes, expectInDinWindow, type RecordedBox } from "../helpers/din5008";

// Der Mahnungs-Renderer legt sein Dokument selbst an; die Fabrik zeichnet fuer den DIN-Test mit.
const recorded: { stop: () => RecordedBox[] }[] = [];
vi.mock("@/lib/pdf/document", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pdf/document")>("@/lib/pdf/document");
  return {
    ...actual,
    createPdfDocument: (options: Parameters<typeof actual.createPdfDocument>[0]) => {
      const doc = actual.createPdfDocument(options);
      recorded.push(recordTextBoxes(doc));
      return doc;
    },
  };
});
afterEach(() => {
  recorded.length = 0;
});

const de = docStrings("de");
const ORG = {
  legalName: "Muster GmbH",
  addressLine1: "Hauptstr. 1",
  addressLine2: null,
  postalCode: "21339",
  city: "Lüneburg",
  country: "DE",
  vatId: "DE123456789",
  taxNumber: null,
  email: "info@muster.example",
  phone: null,
  electronicAddress: null,
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Musterbank",
  accountHolder: "Muster GmbH",
};

function columns(keys: LayoutColumnKey[]): LayoutDesignConfig["columns"] {
  const pct: Record<LayoutColumnKey, number> = { pos: 6, article: 10, description: 38, qty: 10, unit: 8, unitPrice: 13, taxRate: 7, discount: 8, total: 16 };
  return keys.map((key) => ({ key, widthPct: pct[key] }));
}
function config(font: LayoutDesignConfig["font"], keys: LayoutColumnKey[]): LayoutDesignConfig {
  return { ...presetConfig("klassik"), font, columns: columns(keys) };
}
const NOTE = (): DeliveryNotePdfData => ({ ...buildSampleDeliveryNoteData(ORG), showPrices: true, showTax: true, showArticleNumber: true });

async function note(cfg: LayoutDesignConfig, data: DeliveryNotePdfData = NOTE()) {
  const pdf = await renderDeliveryNotePdf(data, testPdfTheme({ layoutConfig: cfg }));
  return { pdf, text: (await parsePdf(pdf)).text };
}

describe("Lieferschein mit Design", () => {
  it("Spalten ohne article: kein Art.-Nr.-Kopf trotz showArticleNumber; Schrift Inter", async () => {
    const { pdf, text } = await note(config("inter", ["pos", "description", "qty", "unitPrice", "taxRate", "total"]));
    expect(text).not.toContain(de.columns.articleNumber);
    expect(text).toContain("Beispielartikel A");
    expect(pdf.toString("latin1")).toMatch(/\/BaseFont \/[A-Z]{6}\+Inter/);
  });

  it("mit article-Spalte steht der Kopf", async () => {
    const cfg = config("inter", ["pos", "article", "description", "qty", "total"]);
    const { text } = await note({ ...cfg, columns: cfg.columns.map((c) => (c.key === "article" ? { ...c, widthPct: 22 } : c)) });
    expect(text).toContain(de.columns.articleNumber);
    expect(text).toContain("ART-00001");
  });

  it("unit-Spalte: Kopf Einheit, Menge ohne Einheit in der Mengenzelle", async () => {
    const withUnit = await note(config("inter", ["pos", "description", "qty", "unit", "total"]));
    expect(withUnit.text).toContain("Einheit");
    const without = await note(config("inter", ["pos", "description", "qty", "total"]));
    expect(without.text).not.toContain("Einheit");
  });

  it("showPrices aus: kein Preis trotz unitPrice/total/taxRate in der Konfiguration", async () => {
    const { text } = await note(config("inter", ["pos", "description", "qty", "unitPrice", "taxRate", "total"]), { ...NOTE(), showPrices: false });
    expect(text).not.toContain(de.columns.unitPrice);
    expect(text).not.toContain(de.columns.net);
    expect(text).not.toContain("12,00");
    expect(text).toContain("Beispielartikel A");
  });

  it("showPrices an: Preisspalten und Summen stehen", async () => {
    const { text } = await note(config("inter", ["pos", "description", "qty", "unitPrice", "taxRate", "total"]));
    expect(text).toContain(de.columns.unitPrice);
    expect(text).toContain("12,00");
  });

  it("showTax aus: kein USt-Kopf", async () => {
    const { text } = await note(config("inter", ["pos", "description", "qty", "unitPrice", "taxRate", "total"]), { ...NOTE(), showTax: false });
    expect(text).not.toMatch(/USt(?!-)/);
    const withTax = await note(config("inter", ["pos", "description", "qty", "unitPrice", "taxRate", "total"]));
    expect(withTax.text).toMatch(/USt(?!-)/);
  });
});

describe("Lieferschein: DIN-5008-Fenster", () => {
  for (const [font, size] of [["inter", 8], ["ibm-plex-serif", 12]] as const) {
    it(`${font} ${size} pt mit Lieferanschrift-Zusatzblock: Kopf im Fenster`, async () => {
      const data: DeliveryNotePdfData = {
        ...NOTE(),
        showDeliveryAddress: true,
        deliveryAddress: { addressLine1: "Lager Nord, Hafenstraße 1", postalCode: "20095", city: "Hamburg", countryCode: "DE" },
      };
      await note({ ...presetConfig("standard"), font, fontSizePt: size }, data);
      const boxes = recorded[0]!.stop();
      const b = data.buyer;
      expectInDinWindow(boxes, [
        senderLineFallback(data.seller),
        b.name,
        b.contactName!,
        b.addressLine1,
        `${b.postalCode} ${b.city}`,
        de.meta.deliveryNoteAddress,
        "Lager Nord, Hafenstraße 1",
        "20095 Hamburg",
      ]);
    });
  }
});

describe("Mahnung mit Design", () => {
  it("source-serif-4: Schrift eingebettet, Kernangaben vorhanden", async () => {
    const data = buildSampleDunningData(ORG);
    const pdf = await renderDunningPdf(data, testPdfTheme({ layoutConfig: { ...presetConfig("standard"), font: "source-serif-4" } }));
    expect(pdf.toString("latin1")).toMatch(/\/BaseFont \/[A-Z]{6}\+SourceSerif4/);
    const { text } = await parsePdf(pdf);
    expect(text).toContain(data.invoiceNumber);
    expect(text).toContain("119,00");
  });

  it("Kopf bleibt im DIN-5008-Fenster", async () => {
    const data = buildSampleDunningData(ORG);
    const base = presetConfig("standard");
    await renderDunningPdf(data, testPdfTheme({ layoutConfig: { ...base, font: "inter", fontSizePt: 12 } }));
    const boxes = recorded[0]!.stop();
    const b = data.buyer;
    expectInDinWindow(boxes, [b.name, b.addressLine1, `${b.postalCode} ${b.city}`]);
  });

  it("Kopf mit Absenderzeile bleibt im DIN-5008-Fenster (8 pt, Inter)", async () => {
    const data = buildSampleDunningData(ORG);
    const base = presetConfig("standard");
    await renderDunningPdf(data, testPdfTheme({ layoutConfig: { ...base, font: "inter", fontSizePt: 8 } }));
    const boxes = recorded[0]!.stop();
    const b = data.buyer;
    expectInDinWindow(boxes, [senderLineFallback(data.seller), b.name, b.contactName!, b.addressLine1, `${b.postalCode} ${b.city}`]);
  });

  it("Grundgroesse und Raender werden uebernommen: Text steht rechts vom linken Rand", async () => {
    const base = presetConfig("standard");
    await renderDunningPdf(buildSampleDunningData(ORG), testPdfTheme({ layoutConfig: { ...base, marginsMm: { ...base.marginsMm, left: 30 } }, options: { ...testPdfTheme().options, showPageNumbers: false } }));
    const boxes = recorded[0]!.stop().filter((x) => x.xPt > 0);
    expect(Math.min(...boxes.map((x) => x.xPt))).toBeGreaterThanOrEqual(85.0);
  });
});
