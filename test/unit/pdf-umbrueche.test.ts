/**
 * fix/pdf-umbrueche — Umbruchfehler im Beleg-PDF (Referenzfall mit neun Positionen und
 * langen Aufzaehlungs-Beschreibungen):
 * B1 Positionstexte duerfen nie in die Fusszeilen-Zone ragen (Seitenumbruch zeilenweise),
 * B2 Fusszeilenfelder ohne inneren Umbruch (siehe pdf-footer.test.ts),
 * B3 Aufzaehlungen haengend eingerueckt, gleichmaessige Abstaende,
 * B4 Bindestriche bleiben im Text erhalten (Umbruch nur an Leerzeichen).
 * Die Positionen stammen aus `pdf-referenz-fixture.ts` (Text aus dem Referenzfall).
 */
import { describe, it, expect } from "vitest";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import PDFDocument from "pdfkit";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { buildFooterColumns } from "@/lib/pdf/footer";
import { wrapRuns } from "@/lib/pdf/text-wrap";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { sampleDeliveryNote } from "../helpers/pdf-fixtures";
import { testPdfTheme } from "../helpers/pdf-theme";

interface Item {
  str: string;
  x: number;
  y: number;
  page: number;
}

type PageData = { pageIndex: number; getTextContent: () => Promise<{ items: { str: string; transform: number[] }[] }> };

/** Alle Textobjekte mit Seite und Position (PDF-Koordinaten, y waechst nach oben). */
async function extractItems(pdf: Buffer): Promise<Item[]> {
  const collect = async (buf: Buffer): Promise<Item[]> => {
    const items: Item[] = [];
    await pdfParse(buf, {
      pagerender: (pageData: PageData) =>
        pageData.getTextContent().then((content) => {
          for (const it of content.items) {
            if (it.str.trim() !== "") items.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, page: pageData.pageIndex });
          }
          return "";
        }),
    });
    return items;
  };
  try {
    return await collect(pdf);
  } catch {
    // pdf-parse (pdf.js ~2017) wirft gelegentlich "bad XRef entry" — siehe test/helpers/pdf-theme.ts#parsePdf.
    return await collect(Buffer.from(pdf));
  }
}

const theme = referenzTheme();
const invoice = referenzInvoice();
const footerLines = new Set(
  buildFooterColumns(
    { seller: invoice.seller, iban: invoice.iban, bic: invoice.bic, bankName: invoice.bankName, ...theme.footerFacts },
    theme.brand,
  ).flatMap((c) => c.lines),
);

// Bei schmalen Spalten darf der Firmenname umbrechen -> auch einzelne Teilstuecke zaehlen als Fusszeile.
const footerFragments = new Set([...footerLines].flatMap((l) => l.split(" ")));

function isFooterItem(item: Item): boolean {
  // Fusszeilen-Band liegt im unteren Seitenviertel (PDF-y < 130); der Firmenname steht in
  // manchen Layouts zusaetzlich im Kopf und darf dort nicht als Fusszeile zaehlen.
  if (item.y >= 130) return false;
  const str = item.str;
  return footerLines.has(str) || footerFragments.has(str) || str.startsWith("IBAN DE") || /^Seite \d+ von \d+$/.test(str);
}

describe("B1 — nichts in der Fusszeilen-Zone", () => {
  it("Referenzbeleg: auf jeder Seite liegt jede Inhaltszeile oberhalb der Fusszeile", async () => {
    const pdf = await renderInvoicePdf(invoice, theme);
    const items = await extractItems(pdf);
    const pages = [...new Set(items.map((i) => i.page))];
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) {
      const onPage = items.filter((i) => i.page === page);
      const footer = onPage.filter((i) => isFooterItem(i) && !/^Seite/.test(i.str));
      expect(footer.length).toBeGreaterThan(0);
      const footerTop = Math.max(...footer.map((i) => i.y)); // oberste Fusszeilen-Grundlinie
      const content = onPage.filter((i) => !isFooterItem(i));
      const lowest = Math.min(...content.map((i) => i.y)); // unterste Inhalts-Grundlinie
      // Grundlinie der untersten Inhaltszeile muss mindestens eine Zeilenhoehe ueber der
      // obersten Fusszeilen-Grundlinie liegen (8 pt Schrift + Luft).
      expect(lowest, `Seite ${page + 1}: Inhalt ragt in die Fusszeile`).toBeGreaterThan(footerTop + 8);
    }
  });

  it("die lange Beschreibung von Position 4 bricht zeilenweise auf Seite 2 um, der Tabellenkopf wiederholt sich", async () => {
    const pdf = await renderInvoicePdf(invoice, theme);
    const items = await extractItems(pdf);
    const page2 = items.filter((i) => i.page === 1);
    expect(page2.some((i) => i.str === "Pos.")).toBe(true);
    // Nachzuegler-Zeile von Position 4 steht auf Seite 2, nicht mehr auf Seite 1
    expect(page2.some((i) => i.str.includes("Ergebnis: Filter, ATP und Archiv"))).toBe(true);
    // Titelzeile einer Position steht nie allein: auf derselben Seite folgen Beschreibungszeilen
    const page1 = items.filter((i) => i.page === 0);
    const title4 = page1.find((i) => i.str.includes("Umstellung des Mailflusses"));
    expect(title4).toBeDefined();
    expect(page1.some((i) => i.str.includes("BSI IT-Grundschutz APP.5.3") && i.y < title4!.y)).toBe(true);
  });

  it("alle Layouts: Inhalt bleibt ueber der Fusszeile", async () => {
    for (const layoutId of ["standard", "klassik", "modern", "blau", "schwarz", "kompakt"] as const) {
      const t = referenzTheme({ layoutId });
      const pdf = await renderInvoicePdf(invoice, t);
      const items = await extractItems(pdf);
      for (const page of new Set(items.map((i) => i.page))) {
        const onPage = items.filter((i) => i.page === page);
        const footer = onPage.filter((i) => isFooterItem(i) && !/^Seite/.test(i.str));
        if (footer.length === 0) continue;
        const footerTop = Math.max(...footer.map((i) => i.y));
        const lowest = Math.min(...onPage.filter((i) => !isFooterItem(i)).map((i) => i.y));
        expect(lowest, `${layoutId} Seite ${page + 1}`).toBeGreaterThan(footerTop + 6);
      }
    }
  });
});

describe("B3 — Aufzaehlungen haengend eingerueckt, gleichmaessige Abstaende", () => {
  it("Folgezeilen beginnen am Textanfang, nicht am Aufzaehlungszeichen (Listen und getippte Bullets)", async () => {
    const items = await extractItems(await renderInvoicePdf(invoice, theme));
    const page1 = items.filter((i) => i.page === 0);
    const x = (prefix: string): number => {
      const it = page1.find((i) => i.str.startsWith(prefix));
      expect(it, prefix).toBeDefined();
      return it!.x;
    };
    // Liste ("- "), Position 1: erste Zeile und Fortsetzung
    expect(x("Einrichtung eines API-Zugangs")).toBeCloseTo(x("Übernahme des Kunden in das Partnerkonto"), 1);
    // getippte "• "-Zeilen, Position 3: Fortsetzung steht unter dem Text, rechts vom Zeichen
    expect(x("änderbar ohne Unwiderruflichkeitssperre")).toBeCloseTo(x("GoBD, § 147 AO"), 1);
    const bullet = page1.filter((i) => i.str === "•").map((i) => i.x);
    expect(bullet.length).toBeGreaterThan(5);
    expect(x("GoBD, § 147 AO")).toBeGreaterThan(Math.min(...bullet) + 2);
  });

  it("Position 2: gleichmaessiger Abstand — auch mit Leerzeile zwischen den ersten Punkten", async () => {
    const items = await extractItems(await renderInvoicePdf(invoice, theme));
    const page1 = items.filter((i) => i.page === 0);
    const first = page1.find((i) => i.str.startsWith("Orientiert an BSI IT-Grundschutz CON.3"))!;
    const last = page1.find((i) => i.str.startsWith("Herstellerticket zum Entzug"))!;
    const ys = [...new Set(page1.filter((i) => i.y <= first.y + 0.1 && i.y >= last.y - 0.1 && i.str !== "•").map((i) => Math.round(i.y * 100) / 100))].sort((a, b) => b - a);
    const diffs = new Set<number>();
    for (let k = 1; k < ys.length; k++) diffs.add(Math.round((ys[k - 1]! - ys[k]!) * 10) / 10);
    // nur zwei verschiedene Abstaende: Zeile-zu-Zeile im Punkt und Punkt-zu-Punkt
    expect(diffs.size).toBeLessThanOrEqual(2);
  });
});

describe("B4 — Bindestriche bleiben im Text erhalten", () => {
  it("Beleg: Woerter mit Bindestrich stehen ungetrennt, keine Zeile endet auf einem Bindestrich", async () => {
    const items = await extractItems(await renderInvoicePdf(invoice, theme));
    const text = items.map((i) => i.str);
    expect(text.some((s) => s.includes("PDF-Fassung"))).toBe(true);
    expect(text.some((s) => s.includes("E-Mail-Sicherheit"))).toBe(true);
    expect(text.filter((s) => /\w-$/.test(s.trimEnd()))).toEqual([]);
  });

  it("zu breites Wort: Trennung nach dem Bindestrich, das Zeichen bleibt erhalten, Text vollstaendig", () => {
    const doc = new PDFDocument({ size: "A4" });
    const word = "Kraftfahrzeug-Haftpflichtversicherungsbeitrag";
    const lines = wrapRuns(doc, [{ text: word, font: "Helvetica" }], 90, 10);
    const joined = lines.map((l) => l.segments.map((s) => s.text).join("")).join("");
    expect(joined).toBe(word);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.segments.map((s) => s.text).join("")).toMatch(/-$/);
  });

  it("normale Woerter brechen nur an Leerzeichen um, nie nach einem Bindestrich", () => {
    const doc = new PDFDocument({ size: "A4" });
    const lines = wrapRuns(doc, [{ text: "Ein langer Satz zur E-Mail-Sicherheit und zur PDF-Fassung im Beleg", font: "Helvetica" }], 110, 10);
    const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t).not.toMatch(/-$/);
    expect(texts.join(" ")).toBe("Ein langer Satz zur E-Mail-Sicherheit und zur PDF-Fassung im Beleg");
  });

  it("Lieferschein: Beschreibung mit Bindestrichen bleibt im Text erhalten", async () => {
    const note = sampleDeliveryNote();
    note.lines[0]!.description = "Übernahme und Bestandsaufnahme E-Mail-Sicherheit und Archivierung mit PDF-Fassung";
    const pdf = await renderDeliveryNotePdf(note, testPdfTheme());
    const items = await extractItems(pdf);
    const all = items.map((i) => i.str).join(" ");
    expect(all).toContain("E-Mail-Sicherheit");
    expect(all).toContain("PDF-Fassung");
  });
});
