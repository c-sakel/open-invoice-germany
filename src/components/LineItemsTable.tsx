/**
 * Gemeinsame Positionstabelle fuer die HTML-Ansichten (Rechnung, Dokument, oeffentliches
 * Angebot) — Server-Komponente (W2, Fix-Welle nach Abschluss-Review). Bildet dieselben
 * Positionsbloecke ab wie PDF/XML (§8): HEADING fett ueber die volle Breite, TEXT als
 * Rich-Text-HTML, SUBTOTAL rechtsbuendig aus computeSubtotals, ITEM mit optionaler
 * Artikelnummer-Spalte und descriptionLong als Rich-Text unter der Bezeichnung. Keine
 * Menge-0-Zeilen mehr sichtbar (Nicht-ITEM-Zeilen zeigen weder Menge noch Preis/Netto).
 *
 * Server-only (parseRichText/renderRichTextHtml ueber den Sammel-Import "@/lib/richtext",
 * der auch den PDF-Renderer buendelt) — im Client NIE importieren, dort nur "@/lib/richtext/
 * parse" + "@/lib/richtext/render-html" direkt (siehe src/components/editor/RichTextField.tsx).
 */
import { parseRichText, renderRichTextHtml } from "@/lib/richtext";
import { computeSubtotals, type LineForSubtotal } from "@/domain/document/lines";
import { formatCents, formatQuantity, formatUnitPrice } from "@/lib/money";
import { unitLabel } from "@/lib/units";
import { docLocale, formatDocMoney, type DocLanguage, type DocStrings } from "@/lib/i18n/doc";

/** Spaltenbeschriftung; Default ist die bisherige deutsche Beschriftung. */
export type LineItemsTableLabels = Pick<DocStrings["columns"], "description" | "articleNumber" | "quantity" | "unitPrice" | "vat" | "net">;

const DEFAULT_LABELS: LineItemsTableLabels = {
  description: "Beschreibung",
  articleNumber: "Art.-Nr.",
  quantity: "Menge",
  unitPrice: "Einzel",
  vat: "USt",
  net: "Netto",
};

const KNOWN_LINE_TYPES = new Set<LineForSubtotal["lineType"]>(["ITEM", "HEADING", "TEXT", "SUBTOTAL"]);

/** Engt eine rohe DB-lineType-Zeichenkette auf die bekannte Union ein (Fallback ITEM,
 *  gleiche Regel wie toLineType in src/lib/einvoice/mapper.ts). */
function toLineType(value: string | null | undefined): LineForSubtotal["lineType"] {
  return value && KNOWN_LINE_TYPES.has(value as LineForSubtotal["lineType"]) ? (value as LineForSubtotal["lineType"]) : "ITEM";
}

export interface LineItemsTableLine {
  id: string;
  /** Roh aus der DB (string) oder bereits die bekannte Union — beides erlaubt. */
  lineType?: string | null;
  description: string;
  descriptionLong?: string | null;
  articleNumber?: string | null;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number;
  /** Phase 18f: Einzelpreis in tausendstel Cent (2 bis 5 Nachkommastellen in der Anzeige). */
  unitNetPriceMilliCents?: number | null;
  taxRate: number;
  lineNetCents: number;
  /** Phase 18f (Abo-Detail): Verbrauchsposition; Text statt Menge, Netto erst beim Lauf bekannt. */
  variableQuantityText?: string;
}

function richTextHtml(markdown: string): string {
  return renderRichTextHtml(parseRichText(markdown));
}

export function LineItemsTable({
  lines,
  currency,
  labels = DEFAULT_LABELS,
  lang,
}: {
  lines: readonly LineItemsTableLine[];
  currency: string;
  labels?: LineItemsTableLabels;
  /** Belegsprache fuer Betrags-/Mengenformat; ohne Angabe wie bisher deutsch. */
  lang?: DocLanguage;
}) {
  const money = (cents: number) => (lang ? formatDocMoney(cents, currency, lang) : formatCents(cents, currency));
  const unitPrice = (l: LineItemsTableLine) => formatUnitPrice(l, currency, lang ? docLocale(lang) : "de-DE");
  const qty = (milli: number) => (lang ? formatQuantity(milli, docLocale(lang)) : formatQuantity(milli));
  const normalized = lines.map((l) => ({ ...l, lineType: toLineType(l.lineType) }));
  const subtotals = computeSubtotals(normalized);
  const showArticleNumber = normalized.some((l) => l.lineType === "ITEM" && l.articleNumber);
  // Beschreibung + ggf. Artikelnummer + USt + Netto (+ Menge/Einzel je nach Layout).
  const totalColumns = showArticleNumber ? 6 : 5;

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-sheet">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-4 py-2">{labels.description}</th>
            {showArticleNumber && <th className="px-4 py-2">{labels.articleNumber}</th>}
            <th className="px-4 py-2 text-right">{labels.quantity}</th>
            <th className="px-4 py-2 text-right">{labels.unitPrice}</th>
            <th className="px-4 py-2 text-right">{labels.vat}</th>
            <th className="px-4 py-2 text-right">{labels.net}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {normalized.map((l, i) => {
            if (l.lineType === "HEADING") {
              return (
                <tr key={l.id}>
                  <td className="px-4 py-2 font-semibold text-ink" colSpan={totalColumns}>
                    {l.description}
                  </td>
                </tr>
              );
            }
            if (l.lineType === "TEXT") {
              return (
                <tr key={l.id}>
                  <td className="px-4 py-2 text-ink-soft" colSpan={totalColumns}>
                    {l.description && <p className="mb-1">{l.description}</p>}
                    {l.descriptionLong && (
                      <div className="rich-text text-ink-soft" dangerouslySetInnerHTML={{ __html: richTextHtml(l.descriptionLong) }} />
                    )}
                  </td>
                </tr>
              );
            }
            if (l.lineType === "SUBTOTAL") {
              return (
                <tr key={l.id} className="font-medium text-ink">
                  <td className="px-4 py-2" colSpan={totalColumns - 1}>
                    {l.description}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{money(subtotals[i])}</td>
                </tr>
              );
            }
            // ITEM
            return (
              <tr key={l.id}>
                <td className="px-4 py-2 text-ink-soft">
                  {l.description}
                  {l.descriptionLong && (
                    <div
                      className="rich-text mt-1 text-xs text-ink-muted"
                      dangerouslySetInnerHTML={{ __html: richTextHtml(l.descriptionLong) }}
                    />
                  )}
                </td>
                {showArticleNumber && <td className="px-4 py-2 text-ink-muted">{l.articleNumber}</td>}
                <td className="tabular px-4 py-2 text-right">
                  {l.variableQuantityText ?? `${qty(l.quantityMilli)} ${unitLabel(l.unit, lang ?? "de")}`}
                </td>
                <td className="tabular px-4 py-2 text-right">{unitPrice(l)}</td>
                <td className="tabular px-4 py-2 text-right">{l.taxRate}%</td>
                <td className="tabular px-4 py-2 text-right">{l.variableQuantityText ? "–" : money(l.lineNetCents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
