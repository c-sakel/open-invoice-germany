/**
 * Proportionale Aufteilung von Belegrabatt/-aufschlag je Steuersatz-Bucket
 * (Largest-Remainder-Verfahren) für EN 16931 BG-20/BG-21 (ALLOWANCES/CHARGES).
 *
 * Rechenbeispiel `allocateProportional`: 1000 Cent auf Gewichte [3333, 3333, 3334]
 * (drei etwa gleich große Buckets, Summe 10000):
 *   exakt   = [333.3, 333.3, 333.4]
 *   floor   = [333, 333, 333]           Summe 999, Rest 1
 *   Bruchteile [0.3, 0.3, 0.4] → größter Bruchteil Index 2 → +1
 *   Ergebnis = [333, 333, 334]          Summe exakt 1000
 *
 * Rechenbeispiel `applyDocumentAdjustments`: Buckets 19 %/10000 Cent netto und
 * 7 %/10000 Cent netto, Belegrabatt 10 % (discountPermille = 100):
 *   D  = round(20000 * 100 / 1000) = 2000
 *   D_r = allocateProportional(2000, [10000, 10000]) = [1000, 1000]
 *   Basis_r = [9000, 9000]  → Steuer 19 %: 1710,00; 7 %: 630,00
 */
import { roundHalfUp } from "../money";
import { PricingError } from "./errors";

/**
 * Verteilt `totalCents` proportional zu `weights` (Largest-Remainder-Methode).
 * - Summe des Ergebnisses ist immer exakt `totalCents`.
 * - Bei Bruchteil-Gleichstand entscheidet der kleinere Index (deterministisch).
 * - Sind alle Gewichte 0, geht der gesamte Betrag auf Index 0 (leeres Array → []).
 */
export function allocateProportional(totalCents: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  if (!Number.isInteger(totalCents)) {
    throw new PricingError(`totalCents muss eine Ganzzahl (Cent) sein: ${totalCents}`);
  }
  // totalCents === 0 ist immer gültig, unabhängig vom Vorzeichen der Gewichte
  // (z. B. Gutschriften mit negativem Netto, aber ohne Beleganpassung).
  if (totalCents === 0) return weights.map(() => 0);

  if (totalCents < 0) {
    throw new PricingError(`totalCents darf nicht negativ sein: ${totalCents}`);
  }
  if (weights.some((w) => w < 0)) {
    throw new PricingError("Gewichte dürfen nicht negativ sein");
  }

  const sumWeights = weights.reduce((a, b) => a + b, 0);

  if (sumWeights === 0) {
    const result = weights.map(() => 0);
    result[0] = totalCents;
    return result;
  }

  const exact = weights.map((w) => (totalCents * w) / sumWeights);
  const floors = exact.map((v) => Math.floor(v));
  const allocated = floors.reduce((a, b) => a + b, 0);
  const remainder = totalCents - allocated;

  const order = weights
    .map((_, i) => ({ i, frac: exact[i] - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floors];
  for (let k = 0; k < remainder; k++) {
    result[order[k].i] += 1;
  }
  return result;
}

export interface DocumentAdjustments {
  /** Prozentualer Belegrabatt in Promille (0..1000). */
  discountPermille?: number;
  /** Zusätzlicher Festbetrags-Belegrabatt in Cent. */
  discountCents?: number;
  /** Prozentualer Belegaufschlag in Promille, wird nach dem Rabatt berechnet. */
  chargePermille?: number;
  /** Zusätzlicher Festbetrags-Belegaufschlag in Cent. */
  chargeCents?: number;
}

export interface RateBucket {
  key: string;
  taxRate: number;
  taxCategory: string;
  netCents: number;
}

export interface AdjustedRateBucket extends RateBucket {
  allowanceCents: number;
  chargeCents: number;
  adjustedNetCents: number;
}

/**
 * Verteilt Belegrabatt und -aufschlag proportional zum Netto je Steuersatz-Bucket.
 * Der Aufschlag wird auf Basis des Netto NACH Rabatt berechnet (D vor C).
 * Wirft `PricingError`, wenn der Rabatt die Nettosumme übersteigt.
 */
export function applyDocumentAdjustments(
  buckets: readonly RateBucket[],
  adj: DocumentAdjustments,
): AdjustedRateBucket[] {
  const discountPermille = adj.discountPermille ?? 0;
  const discountCents = adj.discountCents ?? 0;
  const chargePermille = adj.chargePermille ?? 0;
  const chargeCentsFixed = adj.chargeCents ?? 0;

  const netSum = buckets.reduce((s, b) => s + b.netCents, 0);
  const discountTotal = discountCents + roundHalfUp((netSum * discountPermille) / 1000);

  // Nur eine tatsächlich beantragte Rabattierung (> 0) kann die Nettosumme
  // "übersteigen" — bei 0 bleibt auch eine negative Nettosumme (Gutschrift)
  // unangetastet.
  if (discountTotal > 0 && discountTotal > netSum) {
    throw new PricingError(
      `Belegrabatt (${discountTotal} Cent) übersteigt die Nettosumme (${netSum} Cent)`,
    );
  }

  const netWeights = buckets.map((b) => b.netCents);
  const allowances = allocateProportional(discountTotal, netWeights);
  const bases = buckets.map((b, i) => b.netCents - allowances[i]);

  const baseSum = bases.reduce((s, v) => s + v, 0);
  const chargeTotal = chargeCentsFixed + roundHalfUp((baseSum * chargePermille) / 1000);
  const charges = allocateProportional(chargeTotal, bases);

  return buckets.map((b, i) => ({
    ...b,
    allowanceCents: allowances[i],
    chargeCents: charges[i],
    adjustedNetCents: bases[i] + charges[i],
  }));
}
