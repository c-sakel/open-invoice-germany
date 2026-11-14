/**
 * Positions-Normalisierung fuer Rechnungen/Geschaeftsdokumente (Phase 4b).
 *
 * HEADING/TEXT/SUBTOTAL sind reine Gliederungs-/Anzeigezeilen: sie tragen nie einen
 * Betrag, gehen nie in Summen, XML oder Steuerberechnung ein (Lastenheft §8, "kein
 * Menge-0-Workaround"). Zod (invoiceLineInputSchema) erzwingt das bereits am Boundary;
 * normalizeLines wiederholt die Regel defensiv fuer Aufrufer, die nicht ueber Zod
 * gelaufene Daten weiterreichen (z. B. beim Zusammenbauen aus mehreren Quellen).
 */
import type { InvoiceLineInput, LineType } from "@/schemas";
import { milliCentsToCents, normalizeMilli } from "@/lib/money";

export interface NormalizedLine extends InvoiceLineInput {
  /** Fortlaufende Positionsnummer, 1-basiert, unabhaengig vom Zeilentyp. */
  position: number;
}

/**
 * Weist fortlaufende Positionsnummern zu und erzwingt, dass Nicht-ITEM-Zeilen keine
 * Betraege tragen (Menge, Einzelpreis, Rabatte, Steuersatz = 0).
 */
export function normalizeLines(lines: readonly InvoiceLineInput[]): NormalizedLine[] {
  return lines.map((line, index) => {
    const lineType: LineType = line.lineType ?? "ITEM";
    const isItem = lineType === "ITEM";
    // Phase 18f: defensiv auch fuer Aufrufer ohne Zod-Lauf — Cent-Preis ist die Rundung des Milli-Preises.
    if (isItem) assertMilliConsistent(line);

    return {
      ...line,
      lineType,
      position: index + 1,
      quantityMilli: isItem ? line.quantityMilli : 0,
      unitNetPriceCents: isItem ? line.unitNetPriceCents : 0,
      unitNetPriceMilliCents: isItem ? normalizeMilli(line.unitNetPriceMilliCents) : null,
      servicePeriodStart: isItem ? line.servicePeriodStart : undefined,
      servicePeriodEnd: isItem ? line.servicePeriodEnd : undefined,
      discountPermille: isItem ? (line.discountPermille ?? 0) : 0,
      discountCents: isItem ? (line.discountCents ?? 0) : 0,
      taxRate: isItem ? line.taxRate : 0,
    };
  });
}

/**
 * Wirft, wenn ein Milli-Preis gesetzt ist und `unitNetPriceCents` nicht dessen kaufmaennische
 * Rundung ist (Invariante der Zeile, siehe Schema `refineInvoiceLine`).
 */
export function assertMilliConsistent(l: { unitNetPriceCents: number; unitNetPriceMilliCents?: number | null }): void {
  const milli = l.unitNetPriceMilliCents;
  if (milli === null || milli === undefined) return;
  const expected = milliCentsToCents(milli);
  if (l.unitNetPriceCents !== expected) {
    throw new Error(`Einzelpreis in Cent (${l.unitNetPriceCents}) passt nicht zum Preis in tausendstel Cent (${milli}); erwartet ${expected}.`);
  }
}

/**
 * Preisfelder einer Quellzeile fuer alle Kopierpfade (Storno, Duplikat, Umwandlung, Vorlage ...):
 * Cent-Preis und Milli-Preis bleiben zusammen; `sign` -1 spiegelt beide (Storno/Gutschrift).
 * Bestandszeilen ohne Milli-Preis liefern `unitNetPriceMilliCents: null`.
 */
export function linePriceFields(
  l: { unitNetPriceCents: number; unitNetPriceMilliCents?: number | null },
  sign: 1 | -1 = 1,
): { unitNetPriceCents: number; unitNetPriceMilliCents: number | null } {
  const flip = (v: number): number => (v === 0 ? 0 : sign * v);
  const milli = l.unitNetPriceMilliCents;
  return {
    unitNetPriceCents: flip(l.unitNetPriceCents),
    unitNetPriceMilliCents: milli === null || milli === undefined ? null : flip(milli),
  };
}

/** Minimale Zeilenform, die computeSubtotals benoetigt (Typ + bereits berechnetes Netto). */
export interface LineForSubtotal {
  lineType: LineType;
  lineNetCents: number;
}

/**
 * Berechnet je SUBTOTAL-Zeile die Summe der ITEM-Nettobetraege seit der letzten
 * HEADING- oder SUBTOTAL-Zeile (TEXT-Zeilen unterbrechen die Zwischensumme nicht).
 *
 * Beispiel (Lastenheft): Einrichtung (ITEM, 500,00 €), Hosting (HEADING),
 * Hosting 12 Monate (ITEM, 240,00 €), Domainverwaltung (ITEM, 60,00 €),
 * Zwischensumme Hosting (SUBTOTAL) -> 300,00 € (nur seit der letzten HEADING-Zeile,
 * die Einrichtung fliesst NICHT ein).
 *
 * Rueckgabe: ein zu `lines` paralleles Array; an jedem SUBTOTAL-Index steht die
 * berechnete Zwischensumme (in Cent), an allen anderen Indizes 0.
 */
export function computeSubtotals(lines: readonly LineForSubtotal[]): number[] {
  const result = new Array<number>(lines.length).fill(0);
  let runningNetCents = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    switch (line.lineType) {
      case "ITEM":
        runningNetCents += line.lineNetCents;
        break;
      case "HEADING":
        runningNetCents = 0;
        break;
      case "SUBTOTAL":
        result[i] = runningNetCents;
        runningNetCents = 0;
        break;
      case "TEXT":
        // Reiner Freitext — unterbricht die laufende Zwischensumme nicht.
        break;
    }
  }

  return result;
}
