/**
 * Live-Summen für den Beleg-Editor — reine Übertragung des `useMemo`-Blocks aus
 * `NewInvoiceForm.tsx` (L298-369) in eine pure Funktion. DOCUMENT/DELIVERY_NOTE
 * werden wie REGULAR behandelt (kein Steuerschema-Wechsel für diese Belegarten).
 *
 * Anders als die Formulare heute (die eine ungültige Eingabe stillschweigend als 0
 * behandeln) meldet `computeDraftTotals` eine ungültige Positions-/Beleganpassungs-
 * Eingabe als `error` statt zu rechnen — Positionsmenge und -preis sind Pflichtfelder,
 * ein nicht parsebarer Wert darf keine (falsche) Summe vortäuschen.
 */
import { computeLineNet } from "@/lib/pricing/line";
import { applyDocumentAdjustments, type RateBucket } from "@/lib/pricing/allocate";
import { PricingError } from "@/lib/pricing/errors";
import { computeSubtotals } from "@/domain/document/lines";
import { toCents, toMilli, toPermille } from "./parse";
import { SCHEME_CATEGORY } from "./constants";
import type { DraftState } from "./draft";

export interface DraftTotals {
  lineNetCents: number;
  allowanceCents: number;
  chargeCents: number;
  netCents: number;
  taxRows: { rate: number; taxCents: number; baseCents: number }[];
  taxCents: number;
  grossCents: number;
  subtotals: number[];
  error: string | null;
}

function zeroTotals(lineCount: number, error: string): DraftTotals {
  return {
    lineNetCents: 0,
    allowanceCents: 0,
    chargeCents: 0,
    netCents: 0,
    taxRows: [],
    taxCents: 0,
    grossCents: 0,
    subtotals: new Array(lineCount).fill(0) as number[],
    error,
  };
}

export function computeDraftTotals(d: DraftState): DraftTotals {
  try {
    const isRegular = d.mode === "INVOICE" ? d.taxScheme === "REGULAR" : true;
    const itemLines = d.lines.filter((l) => l.lineType === "ITEM");

    const lineResults = itemLines.map((l) => {
      const quantityMilli = toMilli(l.quantity);
      const unitNetPriceCents = toCents(l.price);
      const discountPermille = l.discountPercent.trim() ? toPermille(l.discountPercent) : 0;
      const discountCents = l.discountAmount.trim() ? toCents(l.discountAmount) : 0;
      if (quantityMilli === null || unitNetPriceCents === null || discountPermille === null || discountCents === null) {
        throw new Error(`Ungültige Eingabe in Position "${l.description || "(ohne Bezeichnung)"}".`);
      }
      return computeLineNet({ quantityMilli, unitNetPriceCents, discountPermille, discountCents });
    });

    const lineNetCents = lineResults.reduce((s, r) => s + r.lineNetCents, 0);

    const byRate = new Map<number, number>();
    itemLines.forEach((l, i) => {
      const rate = isRegular ? l.taxRate : 0;
      byRate.set(rate, (byRate.get(rate) ?? 0) + lineResults[i]!.lineNetCents);
    });
    const category = SCHEME_CATEGORY[d.taxScheme] ?? "S";
    const buckets: RateBucket[] = [...byRate.entries()].map(([taxRate, netCents]) => ({
      key: String(taxRate),
      taxRate,
      taxCategory: category,
      netCents,
    }));

    const documentDiscountPermille = d.documentDiscountPercent.trim() ? toPermille(d.documentDiscountPercent) : 0;
    const documentDiscountCents = d.documentDiscountAmount.trim() ? toCents(d.documentDiscountAmount) : 0;
    const documentChargePermille = d.documentChargePercent.trim() ? toPermille(d.documentChargePercent) : 0;
    const documentChargeCents = d.documentChargeAmount.trim() ? toCents(d.documentChargeAmount) : 0;
    if (
      documentDiscountPermille === null ||
      documentDiscountCents === null ||
      documentChargePermille === null ||
      documentChargeCents === null
    ) {
      throw new Error("Ungültige Eingabe bei Beleg-Rabatt/-Aufschlag.");
    }

    const adjusted = applyDocumentAdjustments(buckets, {
      discountPermille: documentDiscountPermille,
      discountCents: documentDiscountCents,
      chargePermille: documentChargePermille,
      chargeCents: documentChargeCents,
    });

    const taxRows = adjusted.map((b) => ({
      rate: b.taxRate,
      taxCents: Math.round((b.adjustedNetCents * b.taxRate) / 100),
      baseCents: b.adjustedNetCents,
    }));

    const netCents = adjusted.reduce((s, b) => s + b.adjustedNetCents, 0);
    const taxCents = taxRows.reduce((s, r) => s + r.taxCents, 0);
    const allowanceCents = adjusted.reduce((s, b) => s + b.allowanceCents, 0);
    const chargeCents = adjusted.reduce((s, b) => s + b.chargeCents, 0);

    // Subtotal-Zeilen live: Reihenfolge der ITEM-Netto-Ergebnisse deckt sich mit itemLines.
    let itemIdx = 0;
    const subtotalInputs = d.lines.map((l) => {
      if (l.lineType === "ITEM") {
        const r = lineResults[itemIdx++]!;
        return { lineType: l.lineType, lineNetCents: r.lineNetCents };
      }
      return { lineType: l.lineType, lineNetCents: 0 };
    });
    const subtotals = computeSubtotals(subtotalInputs);

    return {
      lineNetCents,
      allowanceCents,
      chargeCents,
      netCents,
      taxRows,
      taxCents,
      grossCents: netCents + taxCents,
      subtotals,
      error: null,
    };
  } catch (e) {
    return zeroTotals(d.lines.length, e instanceof PricingError ? e.message : e instanceof Error ? e.message : "Berechnung fehlgeschlagen.");
  }
}
