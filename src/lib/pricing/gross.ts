/**
 * Brutto-Umrechnung je Steuersatz (Phase 18f).
 *
 * Quelle: EN 16931 BR-CO-17 — die Steuer wird je Steuersatz/-kategorie aus der Summe der
 * Nettobetraege berechnet, nicht je Position. Deshalb wird auch die Brutto->Netto-Umrechnung
 * je Satz statt je Zeile gemacht: Zielbrutto der Gruppe -> Gruppennetto (mit
 * `reconcileNetsForGross`) -> proportional auf die Zeilen verteilt -> je Zeile ein
 * Einzelpreis in Milli-Cent, der exakt dieses Zeilennetto ergibt (sofern loesbar).
 * Eine Rundung je Zeile wuerde sich ueber viele Zeilen aufsummieren.
 *
 * Beispiel: 2 x 9,99 EUR brutto bei 19 %: Ziel 19,98 -> Netto 16,79 -> Einzelpreis
 * 8,395 EUR (839.500 Milli-Cent); Brutto 16,79 + 3,19 = 19,98, Abweichung 0.
 * Eine Abweichung (max. 1 Cent je Steuersatz) wird ausgewiesen, nicht ueber BT-114
 * ausgeglichen (Ruling 2026-11-13, siehe COMPLIANCE § 16). Ist sie bei grossen Mengen nicht
 * mehr exakt loesbar und groesser als 1 Cent je Steuersatz, lehnt die API-Eingabe ab
 * (GROSS_DEVIATION_TOO_LARGE, `price-input.ts`).
 */
import { MAX_UNIT_PRICE_MILLI_CENTS, milliCentsToCents, mulDivRoundHalfUp, normalizeMilli, roundHalfUp } from "../money";
import { computeTaxBreakdown } from "../tax";
import { allocateProportional } from "./allocate";
import { reconcileNetsForGross } from "./partial";

export interface GrossLineInput {
  quantityMilli: number;
  taxRate: number;
  taxCategory: string;
  /** Bruttoeinzelpreis in Cent. */
  unitGrossPriceCents?: number;
  /** Bruttozeilenbetrag in Cent (hat Vorrang vor dem Einzelpreis). */
  lineGrossCents?: number;
}

export interface GrossResolvedLine {
  unitNetPriceCents: number;
  unitNetPriceMilliCents: number | null;
  lineNetCents: number;
  targetGrossCents: number;
  /** false, wenn kein Einzelpreis das gewuenschte Zeilennetto exakt ergibt. */
  exact: boolean;
}

export interface GrossGroupResult {
  taxCategory: string;
  taxRate: number;
  targetGrossCents: number;
  resultGrossCents: number;
  /** resultGrossCents - targetGrossCents der Gruppe */
  deviationCents: number;
  /** true, wenn alle Zeilen der Gruppe exakt loesbar waren und die Abweichung 0 ist. */
  exact: boolean;
}

export interface GrossResolution {
  lines: GrossResolvedLine[];
  groups: GrossGroupResult[];
  targetGrossCents: number;
  resultGrossCents: number;
  /** resultGrossCents - targetGrossCents */
  deviationCents: number;
}

function lineNetOf(quantityMilli: number, cents: number, milli: number | null): number {
  return milli !== null ? mulDivRoundHalfUp(quantityMilli, milli, 1_000_000) : roundHalfUp((quantityMilli * cents) / 1000);
}

function solveLine(quantityMilli: number, netCents: number): Omit<GrossResolvedLine, "targetGrossCents"> {
  if (quantityMilli <= 0) {
    return { unitNetPriceCents: 0, unitNetPriceMilliCents: null, lineNetCents: 0, exact: netCents === 0 };
  }
  const p = mulDivRoundHalfUp(netCents * 1000, 1000, quantityMilli);
  if (p <= MAX_UNIT_PRICE_MILLI_CENTS) {
    for (const cand of [p, p - 1, p + 1]) {
      if (cand < 0 || cand > MAX_UNIT_PRICE_MILLI_CENTS) continue;
      let net: number;
      try {
        net = mulDivRoundHalfUp(quantityMilli, cand, 1_000_000);
      } catch {
        continue;
      }
      if (net === netCents) {
        return {
          unitNetPriceCents: milliCentsToCents(cand),
          unitNetPriceMilliCents: normalizeMilli(cand),
          lineNetCents: net,
          exact: true,
        };
      }
    }
    // Nicht exakt loesbar: naechster Milli-Preis, tatsaechliches Netto ausweisen.
    const net = mulDivRoundHalfUp(quantityMilli, p, 1_000_000);
    if (net <= 2_147_483_647) {
      return { unitNetPriceCents: milliCentsToCents(p), unitNetPriceMilliCents: normalizeMilli(p), lineNetCents: net, exact: false };
    }
  }
  // Grenze ueberschritten: Cent-Preis.
  const cents = mulDivRoundHalfUp(netCents, 1000, quantityMilli);
  return { unitNetPriceCents: cents, unitNetPriceMilliCents: null, lineNetCents: lineNetOf(quantityMilli, cents, null), exact: false };
}

export function resolveGrossLines(lines: readonly GrossLineInput[]): GrossResolution {
  const targets = lines.map((l) => {
    if (l.lineGrossCents !== undefined) return l.lineGrossCents;
    return mulDivRoundHalfUp(l.quantityMilli, l.unitGrossPriceCents ?? 0, 1000);
  });

  const groups = new Map<string, { rate: number; indices: number[] }>();
  lines.forEach((l, i) => {
    const key = `${l.taxCategory}:${l.taxRate}`;
    const g = groups.get(key);
    if (g) g.indices.push(i);
    else groups.set(key, { rate: l.taxRate, indices: [i] });
  });

  const resolved: GrossResolvedLine[] = new Array<GrossResolvedLine>(lines.length);
  const groupResults: GrossGroupResult[] = [];
  for (const g of groups.values()) {
    const groupTargets = g.indices.map((i) => targets[i]);
    const gross = groupTargets.reduce((a, b) => a + b, 0);
    const n0 = mulDivRoundHalfUp(gross, 100, 100 + g.rate);
    const net = reconcileNetsForGross([{ netCents: n0, taxRate: g.rate }], gross)[0];
    const lineNets = allocateProportional(net, groupTargets);
    g.indices.forEach((lineIdx, k) => {
      resolved[lineIdx] = { ...solveLine(lines[lineIdx].quantityMilli, lineNets[k]), targetGrossCents: targets[lineIdx] };
    });
    const first = lines[g.indices[0]];
    const resultGross = computeTaxBreakdown(
      g.indices.map((i) => ({ lineNetCents: resolved[i].lineNetCents, taxRate: lines[i].taxRate, taxCategory: lines[i].taxCategory })),
    ).grossTotalCents;
    groupResults.push({
      taxCategory: first.taxCategory,
      taxRate: g.rate,
      targetGrossCents: gross,
      resultGrossCents: resultGross,
      deviationCents: resultGross - gross,
      exact: resultGross === gross && g.indices.every((i) => resolved[i].exact),
    });
  }

  const targetGrossCents = targets.reduce((a, b) => a + b, 0);
  const resultGrossCents = computeTaxBreakdown(
    resolved.map((r, i) => ({ lineNetCents: r.lineNetCents, taxRate: lines[i].taxRate, taxCategory: lines[i].taxCategory })),
  ).grossTotalCents;
  return { lines: resolved, groups: groupResults, targetGrossCents, resultGrossCents, deviationCents: resultGrossCents - targetGrossCents };
}
