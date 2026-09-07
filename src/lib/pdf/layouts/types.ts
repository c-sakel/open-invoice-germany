/**
 * Layout-Engine (Phase 11b, PDF-Layouts): gemeinsame Typen fuer alle PdfLayouts. Ein
 * `PdfLayout` kapselt die Hooks, mit denen die drei Renderer (Rechnung/Angebot,
 * Lieferschein, Mahnung) Kopf, Tabellenstil, Summenlinie und Fusszeile zeichnen — die
 * Renderer selbst bleiben layout-agnostisch (siehe registry.ts#getLayout).
 */
import type { PdfTheme } from "../theme";
import type { PdfMargins } from "../layout";
import type { LayoutId } from "./ids";

export interface LayoutFrame {
  doc: PDFKit.PDFDocument;
  theme: PdfTheme;
  margins: PdfMargins;
  left: number;
  right: number;
  width: number;
  primary: string;
  /** Grundschriftgroesse in pt (brand.fontSizePt + layout.fontDelta). */
  base: number;
}

export interface KopfMetaRow {
  label: string;
  value: string;
}

export interface KopfInput {
  title: string;
  numberLabel: string;
  number: string;
  meta: KopfMetaRow[];
  recipient: { name: string; contactName?: string | null; addressLine1: string; addressLine2?: string | null; postalCode: string; city: string };
  extraRecipientBlock?: { heading: string; lines: string[] };
  senderFallback: string;
  intro?: string | null;
}

export interface TableStyle {
  headerFill: string | null;
  headerText: string;
  headerHeight: number;
  rowRule: string | null;
  zebra: string | null;
  boldTitle: boolean;
  textColor: string;
}

export interface FooterColumn {
  lines: string[];
}

export interface PdfLayout {
  id: LayoutId;
  name: string;
  description: string;
  fontDelta: number;
  drawKopf(frame: LayoutFrame, input: KopfInput): number;
  table: TableStyle;
  drawTotalsRule(frame: LayoutFrame, x: number, y: number): void;
  drawFooter(frame: LayoutFrame, columns: FooterColumn[], y: number): void;
  footerHeight: number;
  /**
   * Optionaler Hook (Phase 11b, Task 4) fuer Kopf-"Chrome" auf Folgeseiten (z. B. der
   * farbige Balken von `modern`) — wird von den drei Renderern direkt nach `doc.addPage()`
   * aufgerufen. Liefert er eine Zahl, ist das die neue Start-y-Position fuer den
   * Seiteninhalt (statt `margins.top`); bei `void` bleibt der bisherige Standard
   * (`margins.top`) unveraendert. Layouts ohne eigenes Kopf-Chrome lassen den Hook weg.
   */
  drawPageChrome?(frame: LayoutFrame): number | void;
}
