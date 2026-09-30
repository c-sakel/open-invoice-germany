"use client";

/**
 * Eine Zeile der Positionstabelle (Phase 11c, Task 5) — `<tr>` je `DraftLine`, Inhalt
 * abhaengig von `lineType`. ITEM traegt die vollen Spalten (siehe `LineItemsEditor`s
 * Tabellenkopf); HEADING/TEXT/SUBTOTAL kollabieren die mittleren Spalten
 * (Beschreibung…Betrag) auf EINE `<td colSpan={middleColSpan}>` (sieben, bzw. sechs
 * ohne Rabatt-Spalte bei DELIVERY_NOTE, siehe unten) — "reduzierte Zeile" laut Brief,
 * spiegelt `renderInvoicePdf`s Behandlung dieser Zeilentypen (`src/lib/pdf/
 * invoice-pdf.ts` L276-303: HEADING/TEXT/SUBTOTAL haben kein Menge/Preis/USt, nur
 * `description`/`descriptionLong`).
 *
 * Betrag-Zelle (ITEM, berechnet/readonly) und der Brutto-Hinweis unter dem Preisfeld
 * nutzen `computeLineNet` direkt (dieselbe Funktion wie `computeDraftTotals`,
 * `@/lib/pricing/line`) — NICHT die Aggregatwerte aus `DraftTotals` (die liefert nur
 * Summen je Steuersatz, keine Einzelzeilenbetraege). `grossDisplay` ist reine Anzeige:
 * die Betrag-Zelle (readonly, daher gefahrlos umschaltbar) zeigt Netto * (1 + Satz) im
 * Brutto-Modus, das Preisfeld selbst bleibt IMMER an `line.price`
 * (netto) gebunden — nur ein grauer Hinweistext daneben zeigt den Brutto-Aequivalent.
 * `effectiveRate` faellt im INVOICE-Modus bei `taxDisabled` (Steuerschema != REGULAR)
 * auf 0 zurueck, wie `toInvoicePayload`/`computeDraftTotals` es beim Speichern/Rechnen
 * ohnehin tun — sonst wuerde die Anzeige einen Steuersatz einrechnen, den der
 * gespeicherte Beleg nie ansetzt. Aus demselben Grund zeigt das USt-`<select>` bei
 * `taxDisabled` selbst 0 % an statt des (dann irrelevanten) `line.taxRate` (Task-5-
 * Fix, Minor) — sonst wuerde die deaktivierte Anzeige einen Satz behaupten, den der
 * gespeicherte Beleg nie ansetzt.
 *
 * `showDiscount` (Task-5-Fix 2): DELIVERY_NOTE kennt serverseitig kein Rabattfeld
 * (`deliveryNoteLineInputSchema`, `toDeliveryNotePayload` in `draft.ts` sendet keinen
 * Rabatt) — die Rabatt-Spalte/-Zelle wird deshalb bei DELIVERY_NOTE gar nicht erst
 * gerendert (statt eines interaktiven Felds, dessen Wert beim Speichern still
 * verworfen wuerde), reduzierte Zeilen kollabieren dann auf `colSpan={6}` statt `{7}`.
 *
 * Langtext (`descriptionLong`) und Artikelnummer stehen bei jeder ITEM-Zeile direkt unter
 * dem Titel (kompaktes, mitwachsendes Feld, kein Ein-/Ausblenden mehr). Bei DELIVERY_NOTE
 * entfaellt nur der Langtext: `deliveryNoteLineInputSchema` kennt kein `descriptionLong`,
 * ein Eintrag wuerde beim Speichern still verworfen (M1, Abschluss-Review).
 */
import { useState } from "react";
import { clampTaxRate, type DraftLine, type DraftAction, type LineType } from "@/lib/editor/draft";
import { taxRateOptions } from "@/lib/editor/constants";
import type { EditorMode } from "@/lib/editor/constants";
import { toCents, toMilli, centsOrZero, permilleOrZero, fromCents } from "@/lib/editor/parse";
import { computeLineNet } from "@/lib/pricing/line";
import { inputDenseCls } from "@/components/forms/fields";
import { RichTextField } from "../RichTextField";
import { ProductPicker, type ProductOption } from "../ProductPicker";
import { UnitSelect } from "./UnitSelect";
import { LineRowMenu } from "./LineRowMenu";
import { LineDiscountField } from "./LineDiscountField";

/** Hoehe eines Textfelds an den Inhalt anpassen (einzeilig bis zum ersten Umbruch). */
function fitHeight(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// M4 (Abschluss-Review): kein `export` mehr — kein Importer (nur `LineItemsEditor`
// verwendet die Komponente selbst, der Props-Typ wird nirgends separat referenziert).
interface LineRowProps {
  line: DraftLine;
  mode: EditorMode;
  /** Phase 12c — org-eigene Steuersatz-Liste (`DocumentSettings.taxRates`), von
   *  `DocumentEditor` bis hierher durchgereicht. */
  taxRates: readonly number[];
  /** Fortlaufende ITEM-Position (wie im PDF/`itemPos`, `invoice-pdf.ts` L303) — `null`
   *  fuer HEADING/TEXT/SUBTOTAL-Zeilen (die im PDF ebenfalls nicht mitgezaehlt werden). */
  itemPos: number | null;
  isLast: boolean;
  taxDisabled: boolean;
  grossDisplay: boolean;
  products: ProductOption[];
  dispatch: (action: DraftAction) => void;
  subtotalCents: number;
  canRemove: boolean;
  registerDescRef: (key: string, el: HTMLInputElement | HTMLTextAreaElement | null) => void;
  onEnterLast: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onRowKeyDown: (e: React.KeyboardEvent) => void;
  onProductCreated?: (p: ProductOption) => void;
  /** Task 3 (Phase 13b) — "+ Produkt auswählen" in `LineItemsEditor`: fokussiert den
   *  bestehenden `ProductPicker` dieser (neu angelegten) Zeile beim Mount, kein zweites
   *  Suchfeld. */
  autoFocusProduct?: boolean;
}

export function LineRow({
  line,
  mode,
  taxRates,
  itemPos,
  isLast,
  taxDisabled,
  grossDisplay,
  products,
  dispatch,
  subtotalCents,
  canRemove,
  registerDescRef,
  onEnterLast,
  onDragStart,
  onDragOver,
  onDrop,
  onRowKeyDown,
  onProductCreated,
  autoFocusProduct,
}: LineRowProps) {
  const showDiscount = mode !== "DELIVERY_NOTE";
  // Nur waehrend des Anfassens am Griff ist die Zeile ziehbar — sonst wuerde `draggable`
  // auf dem <tr> das Markieren von Text in Eingabefeldern verhindern.
  const [dragArmed, setDragArmed] = useState(false);
  const allowTypeChange = mode !== "DELIVERY_NOTE";

  function patch(p: Partial<DraftLine>) {
    dispatch({ type: "setLine", key: line.key, patch: p });
  }
  function onDescKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (isLast && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onEnterLast();
    }
  }
  function onChangeType(lineType: LineType) {
    dispatch({ type: "setLine", key: line.key, patch: { lineType } });
  }

  const effectiveRate = taxDisabled ? 0 : line.taxRate;
  // Phase 12c — eine bereits gespeicherte Zeile kann einen Satz tragen, der (inzwischen)
  // nicht mehr in der Org-Liste steht (`initialLineToDraftLine` klemmt ihn bewusst NICHT,
  // siehe draft.ts); die Auswahl bleibt dann trotzdem sichtbar/waehlbar, zusaetzlich als
  // "nicht mehr zulässig" markiert, statt sie stillschweigend zu verlieren.
  const baseTaxOptions = taxRateOptions(taxRates);
  const taxOptions = baseTaxOptions.some((o) => o.value === line.taxRate)
    ? baseTaxOptions
    : [...baseTaxOptions, { value: line.taxRate, label: `${line.taxRate}% (nicht mehr zulässig)` }];
  const qtyMilli = toMilli(line.quantity);
  const priceCents = toCents(line.price);
  let amountLabel = "–";
  let grossHint: string | null = null;
  if (line.lineType === "ITEM" && qtyMilli !== null && priceCents !== null) {
    try {
      const { lineNetCents } = computeLineNet({
        quantityMilli: qtyMilli,
        unitNetPriceCents: priceCents,
        discountPermille: permilleOrZero(line.discountPercent),
        discountCents: centsOrZero(line.discountAmount),
      });
      const displayCents = grossDisplay ? Math.round(lineNetCents * (1 + effectiveRate / 100)) : lineNetCents;
      amountLabel = `${fromCents(displayCents)} €`;
      if (grossDisplay) grossHint = `≈ ${fromCents(Math.round(priceCents * (1 + effectiveRate / 100)))} € brutto`;
    } catch {
      amountLabel = "–";
    }
  }

  const reduced = line.lineType !== "ITEM";
  const fieldCls = `${inputDenseCls} w-full min-w-0`;
  // Schmale Container (< 56rem): jede Zeile ist eine Karte im 6-Spalten-Raster, die Zellen
  // tragen ihr Label per `data-label`. Ab `@4xl` klassische Tabellenzeile (table-fixed).
  const cell = "@4xl:table-cell @4xl:py-1.5 @4xl:pr-2 before:mb-0.5 before:block before:text-[11px] before:text-slate-500 before:content-[attr(data-label)] @4xl:before:hidden";
  // Beschreibung…Betrag (ohne Rabatt bei DELIVERY_NOTE, siehe Modulkommentar).
  const middleColSpan = showDiscount ? 7 : 6;

  return (
    <>
      <tr
        draggable={dragArmed}
        onDragStart={onDragStart}
        onDragEnd={() => setDragArmed(false)}
        onDragOver={onDragOver}
        onDrop={() => {
          setDragArmed(false);
          onDrop();
        }}
        onKeyDown={onRowKeyDown}
        className="grid grid-cols-6 gap-x-2 gap-y-2 border-b border-slate-100 py-3 align-top @4xl:table-row @4xl:py-0"
      >
        <td className="order-1 col-span-5 text-xs text-slate-400 @4xl:table-cell @4xl:py-1.5 @4xl:pr-2">
          <span
            className="mr-1 inline-block cursor-grab select-none px-0.5 py-1"
            title="Ziehen zum Sortieren (oder Alt+Pfeil auf/ab)"
            onMouseDown={() => setDragArmed(true)}
            onMouseUp={() => setDragArmed(false)}
          >
            ⠿
          </span>
          {itemPos !== null && <span>{itemPos}</span>}
        </td>

        {reduced ? (
          <td colSpan={middleColSpan} className="order-3 col-span-6 @4xl:table-cell @4xl:py-1.5 @4xl:pr-2">
            {line.lineType === "TEXT" ? (
              <div className="space-y-2">
                <input
                  ref={(el) => registerDescRef(line.key, el)}
                  className={fieldCls}
                  placeholder="Kurztext"
                  value={line.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  onKeyDown={onDescKeyDown}
                />
                <RichTextField label="Langtext (optional)" value={line.descriptionLong} onChange={(v) => patch({ descriptionLong: v })} rows={3} />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  ref={(el) => registerDescRef(line.key, el)}
                  className={`${fieldCls} flex-1`}
                  placeholder={line.lineType === "HEADING" ? "Überschrift" : "Bezeichnung (z. B. Zwischensumme Hosting)"}
                  value={line.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  onKeyDown={onDescKeyDown}
                />
                {line.lineType === "SUBTOTAL" && <span className="whitespace-nowrap text-xs font-medium text-slate-600">{fromCents(subtotalCents)} €</span>}
              </div>
            )}
          </td>
        ) : (
          <>
            <td className="order-3 col-span-6 @4xl:table-cell @4xl:py-1.5 @4xl:pr-2">
              {/* Titel als mitwachsendes Feld (1 Zeile, umbricht bei langem Titel) statt eines
                  einzeiligen Inputs, der lange Titel abschneidet. Enter fuegt keinen
                  Zeilenumbruch ein (Titel ist einzeilig), sondern nur in der letzten Zeile
                  eine neue Position an (`onDescKeyDown`). */}
              <textarea
                ref={(el) => {
                  registerDescRef(line.key, el);
                  fitHeight(el);
                }}
                rows={1}
                className={`${fieldCls} block resize-none overflow-hidden`}
                placeholder="Beschreibung"
                aria-label="Beschreibung"
                value={line.description}
                onChange={(e) => {
                  fitHeight(e.target);
                  patch({ description: e.target.value.replace(/\r?\n/g, " ") });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !(isLast && !e.shiftKey)) e.preventDefault();
                  onDescKeyDown(e);
                }}
              />
              {mode !== "DELIVERY_NOTE" && (
                <div className="mt-1">
                  <RichTextField
                    compact
                    label="Langtext (optional)"
                    placeholder="Langtext (optional)"
                    value={line.descriptionLong}
                    onChange={(v) => patch({ descriptionLong: v })}
                    rows={2}
                  />
                </div>
              )}
              <input
                className={`${fieldCls} mt-1 text-xs`}
                aria-label="Artikelnummer"
                placeholder="Artikelnummer (optional)"
                value={line.articleNumber}
                onChange={(e) => patch({ articleNumber: e.target.value })}
              />
              {products.length > 0 && (
                <div className="mt-1">
                  <ProductPicker
                    products={products}
                    taxRates={taxRates}
                    onPick={(p) => dispatch({ type: "applyProduct", key: line.key, product: p })}
                    onCreated={onProductCreated}
                    autoFocus={autoFocusProduct}
                  />
                </div>
              )}
            </td>
            <td data-label="Menge" className={`order-3 col-span-2 ${cell}`}>
              <input className={fieldCls} aria-label="Menge" value={line.quantity} onChange={(e) => patch({ quantity: e.target.value })} />
            </td>
            <td data-label="Einheit" className={`order-3 col-span-2 ${cell}`}>
              <UnitSelect value={line.unit} onChange={(v) => patch({ unit: v })} />
            </td>
            <td data-label={grossDisplay ? "Preis (brutto)" : "Preis (netto)"} className={`order-3 col-span-2 ${cell}`}>
              <input className={fieldCls} aria-label="Preis" value={line.price} onChange={(e) => patch({ price: e.target.value })} />
              {grossHint && <div className="mt-0.5 text-[11px] text-slate-400">{grossHint}</div>}
            </td>
            <td data-label="USt." className={`order-3 col-span-2 ${cell}`}>
              <select
                className={fieldCls}
                aria-label="USt-Satz"
                value={taxDisabled ? 0 : line.taxRate}
                disabled={taxDisabled}
                onChange={(e) => patch({ taxRate: clampTaxRate(Number(e.target.value), taxRates) })}
              >
                {taxOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </td>
            {showDiscount && (
              <td data-label="Rabatt" className={`order-3 col-span-2 ${cell}`}>
                <LineDiscountField line={line} dispatch={dispatch} />
              </td>
            )}
            <td data-label="Betrag" className={`order-3 col-span-2 tabular-nums @4xl:text-right ${cell}`}>
              {amountLabel}
            </td>
          </>
        )}

        <td className="order-2 col-span-1 text-right @4xl:table-cell @4xl:py-1.5 @4xl:align-top">
          <LineRowMenu
            canRemove={canRemove}
            onDuplicate={() => dispatch({ type: "duplicateLine", key: line.key })}
            onRemove={() => dispatch({ type: "removeLine", key: line.key })}
            currentType={allowTypeChange ? line.lineType : undefined}
            onChangeType={allowTypeChange ? onChangeType : undefined}
          />
        </td>
      </tr>
    </>
  );
}
