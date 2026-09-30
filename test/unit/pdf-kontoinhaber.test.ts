/**
 * fix/kontoinhaber-footer — ein gesetzter Kontoinhaber (kurz oder lang) zerstoerte die
 * Fusszeile: die Zeile war die breiteste der Bank-Spalte, erzwang Umbrueche in Firmenname,
 * Inhaber/-in und IBAN und machte die Fusszeile hoeher. Jetzt steht sie bevorzugt in der Bank-Spalte vor der IBAN
 * (wenn das Raster dadurch gleich bleibt), sonst einzeilig ueber die volle Breite UNTER dem
 * unveraenderten Spaltenraster.
 */
import { describe, it, expect } from "vitest";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { buildFooterColumns } from "@/lib/pdf/footer";
import { createPdfDocument } from "@/lib/pdf/document";
import { pdfMargins } from "@/lib/pdf/layout";
import { getLayout } from "@/lib/pdf/layouts/registry";
import { layoutFooterColumns } from "@/lib/pdf/layouts/shared";
import type { LayoutFrame } from "@/lib/pdf/layouts/types";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";
import { testPdfTheme } from "../helpers/pdf-theme";

const LAYOUTS = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const;
const HOLDERS = ["Christopher Sakel", "Einzelunternehmen Christopher Sakel Prepaid-Host"];

const facts = {
  seller: { name: "Einzelunternehmen Christopher Sakel", addressLine1: "Im Eichengrund 10", postalCode: "37170", city: "Uslar", vatId: "DE335630028", taxNumber: "35/138/02406", email: "contact@prepaid-host.com", phone: "05571 808998" },
  iban: "DE91272400040571069400",
  bic: "COBADEFFXXX",
  bankName: "Commerzbank Holzminden",
  website: "Prepaid-Host.com",
  ownerName: "Christopher Sakel",
};

function frameFor(doc: PDFKit.PDFDocument, theme: ReturnType<typeof testPdfTheme>): LayoutFrame {
  const margins = pdfMargins(theme);
  const left = margins.left;
  const right = doc.page.width - margins.right;
  return { doc, theme, margins, left, right, width: right - left, primary: "#000000", base: 10 };
}

describe("layoutFooterColumns — Kontoinhaber", () => {
  it.each(LAYOUTS)("%s: kurzer Kontoinhaber steht in der Bank-Spalte vor der IBAN, Raster sonst unveraendert", (id) => {
    const theme = testPdfTheme({ layoutId: id });
    const layout = getLayout(id);
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const without = layoutFooterColumns(frame, buildFooterColumns(facts, theme.brand), layout.footerFontSize);
    const laid = layoutFooterColumns(frame, buildFooterColumns({ ...facts, accountHolder: HOLDERS[0] }, theme.brand), layout.footerFontSize);
    expect(laid.columns).toHaveLength(without.columns.length);
    expect(laid.size).toBe(without.size);
    for (let i = 0; i < 3; i++) expect(laid.columns[i]!.lines, `${id} Spalte ${i}`).toEqual(without.columns[i]!.lines);
    const bank = laid.columns[3]!.lines;
    expect(bank).toEqual(["Bank Commerzbank Holzminden", "Kontoinhaber Christopher Sakel", without.columns[3]!.lines[1], "BIC COBADEFFXXX"]);
    expect(bank[2]).toMatch(/^IBAN DE91 2724 /); // IBAN bleibt gruppiert
  });

  it.each(LAYOUTS)("%s: langer Kontoinhaber faellt auf die Vollbreite-Zeile zurueck, Raster identisch", (id) => {
    const theme = testPdfTheme({ layoutId: id });
    const layout = getLayout(id);
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const without = layoutFooterColumns(frame, buildFooterColumns(facts, theme.brand), layout.footerFontSize);
    const accountHolder = HOLDERS[1]!;
    const laid = layoutFooterColumns(frame, buildFooterColumns({ ...facts, accountHolder }, theme.brand), layout.footerFontSize);
    expect(laid.columns.slice(0, without.columns.length), `${id} ${accountHolder}`).toEqual(without.columns);
    const row = laid.columns[laid.columns.length - 1]!;
    expect(row.lines).toEqual([`Kontoinhaber ${accountHolder}`]);
    expect(row.top).toBe(Math.max(...without.columns.map((c) => c.lines.length)));
    expect(laid.height).toBeCloseTo(without.height + laid.lineHeight, 5);
    expect(laid.size).toBe(without.size);
  });

  it("ein extrem langer Kontoinhaber bricht nur in seiner eigenen Zeile um und bleibt in der Breite", () => {
    const theme = testPdfTheme({ layoutId: "standard" });
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const accountHolder = Array.from({ length: 30 }, () => "Beispielgesellschaft").join(" ");
    const laid = layoutFooterColumns(frame, buildFooterColumns({ ...facts, accountHolder }, theme.brand), 7.5);
    const row = laid.columns[laid.columns.length - 1]!;
    expect(row.lines.length).toBeGreaterThan(1);
    doc.font("Helvetica").fontSize(laid.size);
    for (const l of row.lines) expect(doc.widthOfString(l)).toBeLessThanOrEqual(row.width + 0.5);
    expect(laid.columns.slice(0, 4).flatMap((c) => c.lines)).toContain("Einzelunternehmen Christopher Sakel");
  });
});

interface Item {
  str: string;
  y: number;
  page: number;
}
type PageData = { pageIndex: number; getTextContent: () => Promise<{ items: { str: string; transform: number[] }[] }> };

async function extractItems(pdf: Buffer): Promise<Item[]> {
  const collect = async (buf: Buffer): Promise<Item[]> => {
    const items: Item[] = [];
    await pdfParse(buf, {
      pagerender: (pageData: PageData) =>
        pageData.getTextContent().then((content) => {
          for (const it of content.items) if (it.str.trim() !== "") items.push({ str: it.str, y: it.transform[5]!, page: pageData.pageIndex });
          return "";
        }),
    });
    return items;
  };
  try {
    return await collect(pdf);
  } catch {
    return await collect(Buffer.from(pdf));
  }
}

/** Oberste Fusszeilen-Grundlinie: erste Zeile der Spalten (Kontakt/Steuer/Bank-Felder) im Band y < 130. */
function footerTopOf(items: Item[]): number {
  return Math.max(...items.filter((i) => i.y < 130 && /^(Tel\.|E-Mail|USt-IdNr\.|Bank )/.test(i.str)).map((i) => i.y));
}
/** Inhalt = alles oberhalb der obersten Fusszeilen-Grundlinie. */
const contentAbove = (items: Item[], footerTop: number): Item[] => items.filter((i) => i.y > footerTop + 0.5);

describe("Kontoinhaber in der Fusszeile — PDF, alle Layouts", () => {
  it("Rechnung: gleiche Seitenzahl, Kontoinhaber genau einmal je Seite, kein Inhalt in der Fusszone, IBAN ungebrochen", async () => {
    const base = referenzInvoice();
    for (const layoutId of LAYOUTS) {
      const t = referenzTheme({ layoutId });
      const pagesWithout = new Set((await extractItems(await renderInvoicePdf(base, t))).map((i) => i.page)).size;
      for (const accountHolder of HOLDERS) {
        const items = await extractItems(await renderInvoicePdf({ ...base, accountHolder }, t));
        const pages = [...new Set(items.map((i) => i.page))];
        expect(pages.length, `${layoutId}: Seitenzahl`).toBe(pagesWithout);
        for (const page of pages) {
          const onPage = items.filter((i) => i.page === page);
          const holderLines = onPage.filter((i) => i.str.startsWith("Kontoinhaber"));
          expect(holderLines.length, `${layoutId} Seite ${page + 1}: Kontoinhaber`).toBe(1);
          const footerTop = footerTopOf(onPage);
          const content = contentAbove(onPage, footerTop);
          expect(Math.min(...content.map((i) => i.y)), `${layoutId} ${accountHolder} Seite ${page + 1}`).toBeGreaterThan(footerTop + 6);
          expect(onPage.some((i) => /^IBAN DE[0-9 ]{20,}$/.test(i.str)), `${layoutId}: IBAN ungebrochen`).toBe(true);
        }
      }
    }
  });

  it("Mahnung und Lieferschein: Kontoinhaber-Zeile in der Fusszeile, kein Inhalt darunter oder daneben", async () => {
    for (const layoutId of LAYOUTS) {
      const t = testPdfTheme({ layoutId });
      const bank = { iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank", accountHolder: HOLDERS[1] };
      const d = sampleDunning();
      d.seller = { ...d.seller, ...bank };
      const n = sampleDeliveryNote();
      n.seller = { ...n.seller, ...bank };
      for (const pdf of [await renderDunningPdf(d, t), await renderDeliveryNotePdf(n, t)]) {
        const items = await extractItems(pdf);
        const holder = items.filter((i) => i.str.startsWith("Kontoinhaber"));
        expect(holder.length, layoutId).toBe(1);
        const footerTop = footerTopOf(items);
        const content = contentAbove(items, footerTop);
        expect(Math.min(...content.map((i) => i.y)), layoutId).toBeGreaterThan(footerTop + 6);
      }
    }
  });
});

describe("Mahnung und Lieferschein: Fusszeile hat dieselben Spalten wie die Rechnung", () => {
  it("Tel./E-Mail/Web aus dem Verkaeuferdatensatz, vier Spalten wie bei der Rechnung", async () => {
    const t = testPdfTheme({ layoutId: "standard", footerFacts: { website: "Prepaid-Host.com", ownerName: "Christopher Sakel" } });
    const seller = { ...facts.seller, countryCode: "DE", iban: facts.iban, bic: facts.bic, bankName: facts.bankName };
    const d = sampleDunning();
    d.seller = { ...d.seller, ...seller };
    const n = sampleDeliveryNote();
    n.seller = { ...n.seller, ...seller };
    const inv = { ...referenzInvoice(), seller: { ...facts.seller, countryCode: "DE" }, iban: facts.iban, bic: facts.bic, bankName: facts.bankName, accountHolder: null };
    const footerStrings = async (pdf: Buffer): Promise<string[]> => {
      const items = await extractItems(pdf);
      const fields = /^(Tel\.|E-Mail|Web |USt-IdNr\.|Steuer-Nr\.|Inhaber\/-in|Bank |IBAN|BIC)/;
      return [...new Set(items.filter((i) => i.page === 0 && i.y < 130 && fields.test(i.str)).map((i) => i.str))].sort();
    };
    const reference = await footerStrings(await renderInvoicePdf(inv, t));
    expect(reference).toContain("Tel. 05571 808998");
    expect(await footerStrings(await renderDunningPdf(d, t))).toEqual(reference);
    expect(await footerStrings(await renderDeliveryNotePdf(n, t))).toEqual(reference);
  });
});
