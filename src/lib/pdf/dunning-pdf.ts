/**
 * PDF einer Mahnung / Zahlungserinnerung.
 * Phase 7, Task 3 (§35-§36): Briefpapier + Druckoptionen kommen aus einem `PdfTheme`.
 *
 * Phase 11b, Task 3 — Kopf/Summenlinie/Fusszeile kommen jetzt aus einem `PdfLayout`
 * (siehe invoice-pdf.ts). Kein Item-Tabellenkopf noetig (die Aufstellung ist eine
 * einfache zweispaltige Liste, kein `layout.table`).
 */
import PDFDocument from "pdfkit";
import { formatCents } from "@/lib/money";
import { DUNNING_LEVEL_TITLE } from "@/lib/dunning";
import type { PdfTheme } from "./theme";
import { drawFoldMarks, drawPunchMark, drawPageNumbers, concatPdfChunks } from "./marks";
import { pdfMargins, drawBackground } from "./layout";
import { getLayout } from "./layouts/registry";
import type { LayoutFrame } from "./layouts/types";
import { buildFooterColumns } from "./footer";

export interface DunningPdfData {
  number: string;
  level: number;
  /** Name der Mahnstufe (Phase 6) — Titel im PDF, Fallback DUNNING_LEVEL_TITLE[level]. */
  stageName?: string | null;
  sentDate: Date;
  newDueDate: Date;
  currency: string;
  seller: {
    name: string;
    addressLine1: string;
    postalCode: string;
    city: string;
    taxNumber?: string | null;
    vatId?: string | null;
    iban?: string | null;
    bic?: string | null;
    bankName?: string | null;
  };
  buyer: {
    name: string;
    contactName?: string | null;
    addressLine1: string;
    addressLine2?: string | null;
    postalCode: string;
    city: string;
  };
  invoiceNumber: string;
  invoiceDate: Date;
  openAmountCents: number;
  interestCents: number;
  flatFee40Cents: number;
  /** Mahnkosten der Stufe (Phase 6, `DunningStage.feeCents`, nur order >= 2). */
  feeCents: number;
  lateFeeCents: number;
  totalCents: number;
  daysOverdue: number;
}

function deDate(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

const INTRO: Record<number, (n: string) => string> = {
  0: (n) => `bei der Durchsicht unserer Unterlagen ist uns aufgefallen, dass die Rechnung ${n} bislang nicht ausgeglichen wurde. Vermutlich ist Ihnen dies entgangen — wir bitten höflich um Begleichung.`,
  1: (n) => `trotz Fälligkeit ist die Rechnung ${n} bis heute nicht beglichen. Wir fordern Sie auf, den offenen Betrag zuzüglich der entstandenen Verzugskosten bis zum unten genannten Datum zu zahlen.`,
  2: (n) => `auch nach unserer ersten Mahnung ist die Rechnung ${n} weiterhin offen. Wir setzen Ihnen letztmalig eine Frist zur Zahlung, bevor wir weitere Schritte einleiten.`,
};

export function renderDunningPdf(data: DunningPdfData, theme: PdfTheme): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const margins = pdfMargins(theme);
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: margins.top, right: margins.right, bottom: margins.bottom, left: margins.left },
      bufferPages: true,
      compress: theme.compress ?? true,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(concatPdfChunks(chunks)));
    doc.on("error", reject);
    const cur = data.currency;
    const left = margins.left;
    const right = doc.page.width - margins.right;
    const title = data.stageName || DUNNING_LEVEL_TITLE[data.level] || `${data.level}. Mahnung`;

    // Phase 11b — Layout-Hooks statt eigener Kopie der Zeichenlogik.
    const layout = getLayout(theme.layoutId);
    const base = theme.brand.fontSizePt + layout.fontDelta;
    const frame: LayoutFrame = { doc, theme, margins, left, right, width: right - left, primary: theme.brand.primaryColor, base };
    // Fix-Runde 1 (Task-5-Review, Minor): dieselbe `rowH`-Formel wie invoice-pdf.ts —
    // die Zeilen der Gebuehrenaufstellung (`row()`) hatten weiterhin fest 16pt. Bei
    // `base = 10` (Default) unveraendert 16.
    const rowH = Math.round((base - 1) * 1.8);

    // Phase 11b, Task 4 — die Mahnung bricht (anders als Rechnung/Lieferschein) nie
    // manuell um `doc.addPage()`; sie ueberlaesst lange Texte pdfkits eigener
    // Seitenumbruch-Logik. `pageAdded` feuert dabei genauso wie bei einem expliziten
    // `doc.addPage()` (siehe drawBackground oben) — daher hier derselbe Hook, nur ohne
    // Rueckgabewert-Auswertung (keine manuell gefuehrte y-Fortsetzung vorhanden).
    doc.on("pageAdded", () => {
      drawBackground(doc, theme);
      layout.drawPageChrome?.(frame);
    });
    drawBackground(doc, theme);

    let y = layout.drawKopf(frame, {
      title,
      numberLabel: "Nr.",
      number: data.number,
      meta: [{ label: "Datum", value: deDate(data.sentDate) }],
      recipient: data.buyer,
      senderFallback: `${data.seller.name} · ${data.seller.addressLine1} · ${data.seller.postalCode} ${data.seller.city}`,
    });

    doc.fontSize(11).fillColor("#000").text("Sehr geehrte Damen und Herren,", left, y);
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#333").text((INTRO[data.level] ?? INTRO[2])(data.invoiceNumber), { width: right - left });

    // Fix-Runde 2 (Koordinator, Guard b): die Mahnung ueberlaesst Seitenumbrueche sonst
    // vollstaendig pdfkits eigener Logik (siehe Kommentar zu `pageAdded` oben) — bei vielen
    // Gebuehrenzeilen (Zinsen/Pauschale/Mahnkosten/Auslagen) haette das zu derselben
    // kaskadierenden Leerseiten-Gefahr wie in invoice-pdf.ts fuehren koennen, plus dem in
    // dieser Runde behobenen Fusszeilen-Ueberlapp. `ensurePlainSpace` bricht VOR einer
    // Zeile, die nicht mehr in den (bei aktiver Fusszeile reservierten) Rest der Seite
    // passt, manuell um. Der `pageAdded`-Handler oben zeichnet Hintergrund + Kopf-Chrome
    // bereits automatisch fuer JEDEN `doc.addPage()` (auch diesen) — ein zusaetzlicher
    // expliziter `drawPageChrome`-Aufruf hier wuerde ihn doppelt zeichnen.
    const pageBottom = theme.options.showFooter ? doc.page.height - margins.bottom - layout.footerHeight - 6 : doc.page.height - margins.bottom;
    const ensurePlainSpace = (atY: number, needed: number): number => {
      if (atY + needed <= pageBottom) return atY;
      doc.addPage();
      return margins.top;
    };

    // Aufstellung
    y = doc.y + 20;
    const row = (label: string, value: string, bold = false) => {
      y = ensurePlainSpace(y, rowH);
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#000");
      doc.text(label, left, y, { width: 360 });
      doc.text(value, left + 360, y, { width: right - left - 360, align: "right" });
      y += rowH;
    };
    row(`Rechnung ${data.invoiceNumber} vom ${deDate(data.invoiceDate)} — offener Betrag`, formatCents(data.openAmountCents, cur));
    if (data.interestCents > 0) row(`Verzugszinsen (${data.daysOverdue} Tage)`, formatCents(data.interestCents, cur));
    if (data.flatFee40Cents > 0) row("Verzugspauschale (§ 288 Abs. 5 BGB)", formatCents(data.flatFee40Cents, cur));
    if (data.feeCents > 0) row("Mahnkosten", formatCents(data.feeCents, cur));
    if (data.lateFeeCents > 0) row("Sonstige Auslagen", formatCents(data.lateFeeCents, cur));
    y += 4;
    layout.drawTotalsRule(frame, left, y);
    y += 6;
    row("Zahlbarer Gesamtbetrag", formatCents(data.totalCents, cur), true);
    doc.font("Helvetica");

    y += 16;
    doc.fontSize(10).fillColor("#000").text(`Bitte überweisen Sie den Gesamtbetrag bis spätestens ${deDate(data.newDueDate)}.`, left, y, { width: right - left });

    // Fix-Runde 1 (Koordinator, Punkt 6): Fusszeile auf JEDER Seite — `layout.drawFooter`
    // wandert in die Seiten-Schleife (vorher nur auf der zuletzt angelegten Seite).
    const footY = doc.page.height - margins.bottom - layout.footerHeight;
    const footerColumns = buildFooterColumns(
      { seller: data.seller, iban: data.seller.iban, bic: data.seller.bic, bankName: data.seller.bankName, ...theme.footerFacts },
      theme.brand,
    );

    // Falz-/Lochmarken + Seitenzahlen + Fusszeile.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      if (theme.options.showFooter) layout.drawFooter(frame, footerColumns, footY);
      if (theme.options.foldMarks) drawFoldMarks(doc);
      if (theme.options.punchMarks) drawPunchMark(doc);
    }
    if (theme.options.showPageNumbers) drawPageNumbers(doc, theme);

    doc.end();
  });
}
