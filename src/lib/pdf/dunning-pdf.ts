/**
 * PDF einer Mahnung / Zahlungserinnerung.
 * Phase 7, Task 3 (§35-§36): Briefpapier + Druckoptionen kommen aus einem `PdfTheme`.
 *
 * Phase 11b, Task 3 — Kopf/Summenlinie/Fusszeile kommen jetzt aus einem `PdfLayout`
 * (siehe invoice-pdf.ts). Kein Item-Tabellenkopf noetig (die Aufstellung ist eine
 * einfache zweispaltige Liste, kein `layout.table`).
 */
import { formatCents } from "@/lib/money";
import { DUNNING_LEVEL_TITLE } from "@/lib/dunning";
import { docStrings, docLocale, formatDocDate, resolveDocLanguage, type DocLanguage } from "@/lib/i18n/doc";
import type { InterestSegment } from "@/schemas";
import type { PdfTheme } from "./theme";
import { drawFoldMarks, drawPunchMark, drawPageNumbers, drawWatermark, concatPdfChunks } from "./marks";
import { pdfMargins, marginsFromMm, drawBackground, senderLineFallback } from "./layout";
import { addressCountryLine } from "../countries";
import { layoutForTheme } from "./layouts/registry";
import { mergeFooterColumns } from "./layouts/columns";
import { footerZoneHeight } from "./layouts/shared";
import { renderPlainTextPdf } from "@/lib/richtext";
import { drawWrappedLine, wrapRuns } from "./text-wrap";
import type { LayoutFrame } from "./layouts/types";
import { buildFooterColumns } from "./footer";
import { createPdfDocument } from "./document";

export interface DunningPdfData {
  number: string;
  level: number;
  /** Name der Mahnstufe (Phase 6) — Titel im PDF, Fallback DUNNING_LEVEL_TITLE[level]. */
  stageName?: string | null;
  sentDate: Date;
  newDueDate: Date;
  currency: string;
  /** Belegsprache (Snapshot); fehlt sie, gilt Deutsch. */
  language?: DocLanguage;
  seller: {
    name: string;
    addressLine1: string;
    addressLine2?: string | null;
    email?: string | null;
    phone?: string | null;
    postalCode: string;
    city: string;
    /** ISO-Land des Absenders (Snapshot); fehlt es, gilt DE. */
    countryCode?: string | null;
    taxNumber?: string | null;
    vatId?: string | null;
    iban?: string | null;
    bic?: string | null;
    bankName?: string | null;
    accountHolder?: string | null;
  };
  buyer: {
    name: string;
    contactName?: string | null;
    addressLine1: string;
    addressLine2?: string | null;
    postalCode: string;
    city: string;
    /** ISO-Land des Empfaengers (Snapshot). */
    countryCode?: string | null;
  };
  invoiceNumber: string;
  invoiceDate: Date;
  openAmountCents: number;
  interestCents: number;
  /** Phase 14a, Task 3 (R7/R8): Abschnitte der Verzugszinsberechnung ueber Basiszins-
   *  Halbjahresgrenzen — vorhanden, sobald die Mahnung sie beim Erstellen gespeichert hat
   *  (`interestSegmentsJson`, Snapshot). Ohne sie (Altmahnung oder Stufe ohne Verzinsung)
   *  bleibt die bisherige Einzelzeile aus `interestCents`/`daysOverdue` stehen. */
  interestSegments?: InterestSegment[];
  flatFee40Cents: number;
  /** Mahnkosten der Stufe (Phase 6, `DunningStage.feeCents`, nur order >= 2). */
  feeCents: number;
  lateFeeCents: number;
  totalCents: number;
  daysOverdue: number;
}

export function renderDunningPdf(data: DunningPdfData, theme: PdfTheme): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Phase 16g: Design-Konfiguration (Schrift, Raender, Farben, Grundgroesse) nur, wenn gesetzt;
    // Spalten und Rumpfbloecke gelten nicht (die Forderungsaufstellung ist fest).
    const layout = layoutForTheme(theme);
    const margins = layout.marginsMm ? marginsFromMm(layout.marginsMm) : pdfMargins(theme);
    const doc = createPdfDocument({
      size: "A4",
      margins,
      compress: theme.compress ?? true,
      pdfa: true,
      fontFamily: layout.font,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(concatPdfChunks(chunks)));
    doc.on("error", reject);
    const cur = data.currency;
    const lang = resolveDocLanguage(data.language);
    const t = docStrings(lang);
    const locale = docLocale(lang);
    const deDate = (d: Date): string => formatDocDate(d, lang);
    const money = (cents: number): string => formatCents(cents, cur, locale);
    const left = margins.left;
    const right = doc.page.width - margins.right;
    // Stufennamen sind frei pflegbare Stammdaten (Deutsch); die Standardnamen werden in der Belegsprache angezeigt.
    const stageNameIsDefault = !data.stageName || Object.values(DUNNING_LEVEL_TITLE).includes(data.stageName);
    const title =
      lang !== "de" && stageNameIsDefault
        ? (t.titles.DUNNING[data.level] ?? t.titles.dunningLevel(data.level))
        : data.stageName || DUNNING_LEVEL_TITLE[data.level] || `${data.level}. Mahnung`;

    // Phase 11b — Layout-Hooks statt eigener Kopie der Zeichenlogik.
    const base = (layout.fontSizePt ?? theme.brand.fontSizePt) + layout.fontDelta;
    const frame: LayoutFrame = { doc, theme, margins, left, right, width: right - left, primary: layout.colors?.primary ?? theme.brand.primaryColor, base };
    // Bestandslayouts: feste 11/10 pt und Schwarz/#333; Designs skalieren mit der Grundgroesse.
    const isDesign = layout.fontSizePt !== undefined;
    const salutationSize = isDesign ? base + 1 : 11;
    const bodySize = isDesign ? base : 10;
    const ink = layout.colors?.text ?? "#000";
    const introInk = layout.colors?.text ?? "#333";
    const labelWidth = isDesign ? Math.min(360, right - left - 100) : 360;
    // Fix-Runde 1 (Task-5-Review, Minor): dieselbe `rowH`-Formel wie invoice-pdf.ts —
    // die Zeilen der Gebuehrenaufstellung (`row()`) hatten weiterhin fest 16pt. Bei
    // `base = 10` (Default) unveraendert 16.
    const rowH = Math.round((base - 1) * 1.8);

    // Phase 11b, Task 4 — die Mahnung bricht (anders als Rechnung/Lieferschein) nie
    // manuell um `doc.addPage()`; sie ueberlaesst lange Texte pdfkits eigener
    // Seitenumbruch-Logik. `pageAdded` feuert dabei genauso wie bei einem expliziten
    // `doc.addPage()` (siehe drawBackground oben) — daher hier derselbe Hook.
    //
    // Fix-Welle (Abschluss-Review, Block 3 "Minor"): der Hook wertete `drawPageChrome`s
    // Rueckgabewert (die neue Start-y fuer den Seiteninhalt, z. B. unterhalb des `modern`-
    // Balkens) bisher NICHT aus — `ensurePlainSpace` unten gab bei einem Seitenumbruch
    // immer `margins.top` zurueck, sodass eine mehrseitige Mahnung im `modern`-Layout ihre
    // erste Zeile auf Folgeseiten ueber den Balken haette drucken koennen. `chromeStartY`
    // merkt sich die Rueckgabe fuer `ensurePlainSpace`.
    let chromeStartY: number | undefined;
    doc.on("pageAdded", () => {
      drawBackground(doc, theme);
      const chromeResult = layout.drawPageChrome?.(frame);
      chromeStartY = typeof chromeResult === "number" ? chromeResult : undefined;
    });
    drawBackground(doc, theme);

    let y = layout.drawKopf(frame, {
      title,
      numberLabel: t.numberLabels.DUNNING,
      number: data.number,
      meta: [{ label: t.meta.date, value: deDate(data.sentDate) }],
      recipient: { ...data.buyer, countryLine: addressCountryLine(data.buyer.countryCode, lang) },
      senderFallback: senderLineFallback(data.seller, lang),
    });

    doc.fontSize(salutationSize).fillColor(ink).text(t.dunning.salutation, left, y);
    doc.moveDown(0.5);
    doc.fontSize(bodySize).fillColor(introInk).text(t.dunning.intro[(data.level in t.dunning.intro ? data.level : 2) as 0 | 1 | 2](data.invoiceNumber), { width: right - left });

    // Fix-Runde 2 (Koordinator, Guard b): die Mahnung ueberlaesst Seitenumbrueche sonst
    // vollstaendig pdfkits eigener Logik (siehe Kommentar zu `pageAdded` oben) — bei vielen
    // Gebuehrenzeilen (Zinsen/Pauschale/Mahnkosten/Auslagen) haette das zu derselben
    // kaskadierenden Leerseiten-Gefahr wie in invoice-pdf.ts fuehren koennen, plus dem in
    // dieser Runde behobenen Fusszeilen-Ueberlapp. `ensurePlainSpace` bricht VOR einer
    // Zeile, die nicht mehr in den (bei aktiver Fusszeile reservierten) Rest der Seite
    // passt, manuell um. Der `pageAdded`-Handler oben zeichnet Hintergrund + Kopf-Chrome
    // bereits automatisch fuer JEDEN `doc.addPage()` (auch diesen) — ein zusaetzlicher
    // expliziter `drawPageChrome`-Aufruf hier wuerde ihn doppelt zeichnen.
    // fix/pdf-umbrueche (B1/B2): Fusszone aus der tatsaechlichen Fusszeile messen.
    const builtFooterColumns = buildFooterColumns(
      {
        seller: data.seller,
        iban: data.seller.iban,
        bic: data.seller.bic,
        bankName: data.seller.bankName,
        accountHolder: data.seller.accountHolder,
        ...theme.footerFacts,
      },
      layout.footerMode ? { ...theme.brand, footerMode: layout.footerMode } : theme.brand,
      lang,
    );
    const footerColumns = layout.footerColumnCount ? mergeFooterColumns(builtFooterColumns, layout.footerColumnCount) : builtFooterColumns;
    const footerZone = footerZoneHeight(frame, layout, footerColumns);
    const pageBottom = theme.options.showFooter ? doc.page.height - margins.bottom - footerZone - 6 : doc.page.height - margins.bottom;
    const ensurePlainSpace = (atY: number, needed: number): number => {
      if (atY + needed <= pageBottom) return atY;
      doc.addPage();
      // Fix-Welle: `chromeStartY` statt hart `margins.top` — siehe Kommentar oben.
      return typeof chromeStartY === "number" ? chromeStartY : margins.top;
    };

    // Aufstellung
    y = doc.y + 20;
    const row = (label: string, value: string, bold = false) => {
      // fix/pdf-umbrueche: lange Zeilenbeschriftungen (Zins-Abschnitte) selbst umbrechen und
      // die Zeilenhoehe danach bemessen — sonst ueberdruckt der Umbruch die Folgezeile.
      const font = bold ? "Helvetica-Bold" : "Helvetica";
      doc.font(font).fontSize(bodySize);
      const labelLines = wrapRuns(doc, [{ text: label, font }], labelWidth, bodySize);
      const lineHeight = doc.currentLineHeight(true);
      const h = rowH + (labelLines.length - 1) * lineHeight;
      y = ensurePlainSpace(y, h);
      doc.fillColor(ink);
      labelLines.forEach((ll, li) => drawWrappedLine(doc, ll, left, y + li * lineHeight, bodySize));
      doc.font(font).fontSize(bodySize).text(value, left + labelWidth, y, { width: right - left - labelWidth, align: "right", lineBreak: false });
      y += h;
    };
    row(t.dunning.invoiceRow(data.invoiceNumber, deDate(data.invoiceDate)), money(data.openAmountCents));
    if (data.interestCents > 0) {
      // Phase 14a, Task 3 (R7/R8): liegt die Verzugsperiode ueber einer Basiszins-
      // Halbjahresgrenze, zeigt jede Zeile ihren eigenen Abschnitt samt dort gueltigem
      // Satz — die je Abschnitt gerundeten Betraege koennen sich in Summe um wenige Cent
      // vom (einmal ueber die exakte Summe gerundeten) `interestCents` unterscheiden;
      // massgeblich fuer den Gesamtbetrag bleibt ausschliesslich `data.totalCents` unten.
      // Ohne Segmente (Altmahnung vor dieser Migration) bleibt die bisherige Einzelzeile.
      if (data.interestSegments && data.interestSegments.length > 0) {
        for (const seg of data.interestSegments) {
          const ratePct = (seg.baseRateBp / 100).toFixed(2).replace(".", ",");
          const points = (seg.pointsBp / 100).toFixed(0);
          row(t.dunning.interestSegment(deDate(new Date(seg.from)), deDate(new Date(seg.to)), seg.days, ratePct, points), money(seg.interestCents));
        }
      } else {
        row(t.dunning.interestSingle(data.daysOverdue), money(data.interestCents));
      }
    }
    if (data.flatFee40Cents > 0) row(t.dunning.flatFee, money(data.flatFee40Cents));
    if (data.feeCents > 0) row(t.dunning.fee, money(data.feeCents));
    if (data.lateFeeCents > 0) row(t.dunning.otherCosts, money(data.lateFeeCents));
    y += 4;
    layout.drawTotalsRule(frame, left, y);
    y += 6;
    row(t.dunning.total, money(data.totalCents), true);
    doc.font("Helvetica");

    y += 16;
    // Fix-Welle (Abschluss-Review, Block 2 "Important"): derselbe Fusszeilen-Ueberlapp wie
    // in invoice-pdf.ts — dieser Schlusssatz wurde bisher ohne `ensurePlainSpace`-Schutz
    // gezeichnet und konnte auf der Fusszeile landen (pdfkits eigene automatische
    // Paginierung kennt nur `margins.bottom`, nicht die zusaetzlichen `footerHeight + 6`
    // Reservierung von `pageBottom`).
    y = ensurePlainSpace(y, 30);
    renderPlainTextPdf(doc, t.dunning.payBy(deDate(data.newDueDate)), y, {
      x: left,
      width: right - left,
      fontSize: bodySize,
      ensureSpace: ensurePlainSpace,
      color: ink,
    });

    // Fix-Runde 1 (Koordinator, Punkt 6): Fusszeile auf JEDER Seite — `layout.drawFooter`
    // wandert in die Seiten-Schleife (vorher nur auf der zuletzt angelegten Seite).
    const footY = doc.page.height - margins.bottom - footerZone;

    // Falz-/Lochmarken + Seitenzahlen + Fusszeile.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      if (theme.options.showFooter) layout.drawFooter(frame, footerColumns, footY);
      if (theme.options.foldMarks) drawFoldMarks(doc);
      if (theme.options.punchMarks) drawPunchMark(doc);
      if (theme.watermark) drawWatermark(doc, theme.watermark);
    }
    if (theme.options.showPageNumbers) drawPageNumbers(doc, theme, lang);

    doc.end();
  });
}
