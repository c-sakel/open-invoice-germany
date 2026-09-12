/**
 * Verzugszins-Berechnung nach § 288 BGB (rein, testbar).
 *
 * Verzugszins = (Basiszinssatz + Zuschlag) p.a. auf den offenen Betrag, taggenau.
 * Zuschlag: 5 Prozentpunkte ggü. Verbraucher (B2C), 9 Pp im B2B (§ 288 Abs. 1/2).
 * 40-€-Pauschale (§ 288 Abs. 5) nur B2B, einmal je Forderung (EuGH C-419/21).
 * Quellen: COMPLIANCE.md Abschnitt 12.
 *
 * Phase 14a, Task 3 (R7): der Basiszinssatz aendert sich zum 1.1./1.7. — liegt eine
 * Verzugsperiode ueber eine solche Grenze, muss sie je Abschnitt (Halbjahr) mit dem dort
 * gueltigen Satz gerechnet werden (`computeInterestSegments`). `computeDunning` bleibt als
 * Einzelsatz-Fall (Signatur unveraendert) erhalten und delegiert intern an die Segment-
 * funktion mit genau einem Satz — bestehende Aufrufer/Tests bleiben unveraendert gruen.
 */
import { roundHalfUp } from "./money";
import { rateForDate, type BaseRateEntry } from "@/domain/dunning/base-rate";
import type { InterestSegment } from "@/schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Basiszinssatz in Basispunkten (1 % = 100 bp). 1,27 % zum 01.01.2026 (Bundesbank).
 *  Bewegliches Ziel — halbjährliche Anpassung (1.1./1.7.); per Override aktualisierbar.
 *  Notnagel: greift nur, wenn `computeDunning` ohne `baseRateBp` aufgerufen wird — der
 *  produktive Pfad (`createDunning`) uebergibt immer eine echte Basiszinssatz-Historie
 *  (`loadBaseRates`) an `computeInterestSegments`, nie diesen Default. */
export const DEFAULT_BASE_RATE_BP = 127;

export interface DunningCalcInput {
  openAmountCents: number;
  daysOverdue: number;
  isConsumer: boolean;
  baseRateBp?: number;
  applyFlatFee: boolean;
}

export interface DunningCalcResult {
  pointsBp: number;
  baseRateBp: number;
  interestCents: number;
  flatFee40Cents: number;
  totalCents: number;
}

export function computeDunning(input: DunningCalcInput): DunningCalcResult {
  const baseRateBp = input.baseRateBp ?? DEFAULT_BASE_RATE_BP;
  const days = Math.max(0, input.daysOverdue);
  const from = new Date(0);
  const to = new Date(days * DAY_MS);
  const segments = computeInterestSegments({
    openAmountCents: input.openAmountCents,
    from,
    to,
    isConsumer: input.isConsumer,
    rates: [{ validFrom: from, rateBp: baseRateBp }],
  });
  const interestCents = segments.interestCents;
  const flatFee40Cents = input.applyFlatFee && !input.isConsumer ? 4000 : 0;
  return {
    pointsBp: segments.pointsBp,
    baseRateBp,
    interestCents,
    flatFee40Cents,
    totalCents: input.openAmountCents + interestCents + flatFee40Cents,
  };
}

export interface ComputeInterestSegmentsInput {
  openAmountCents: number;
  /** Beginn des Verzugszeitraums (i. d. R. `invoice.dueDate`), inklusiv. */
  from: Date;
  /** Ende des Verzugszeitraums (i. d. R. `now` der Mahnung), exklusiv (`daysBetween`). */
  to: Date;
  isConsumer: boolean;
  /** Basiszinssatz-Historie (mind. 1 Eintrag, siehe `loadBaseRates`/`rateForDate`). */
  rates: readonly BaseRateEntry[];
}

export interface ComputeInterestSegmentsResult {
  segments: InterestSegment[];
  /** Gesamtbetrag ueber ALLE Abschnitte — Rundung erfolgt EINMAL ueber die exakte
   *  Bruch-Summe (R7), nicht als Summe der (je fuer sich gerundeten) `segments[].interestCents`. */
  interestCents: number;
  /** Tagegewichteter Mittelwert des Basiszinssatzes in bp, gerundet (R8, `baseInterestRatePermille`-Snapshot). */
  baseRateBpWeighted: number;
  pointsBp: number;
}

/**
 * Stueckelt eine Verzugsperiode `[from, to)` an jeder `validFrom`-Grenze der
 * Basiszinssatz-Historie und berechnet je Abschnitt `offen * (Basiszins + Zuschlag) *
 * Tage / (10000 * 365)` als exakten (ungerundeten) Bruch — `interestCents` (gesamt) rundet
 * diese Summe genau EINMAL (R7), damit das Ergebnis nicht gegenueber der einstufigen
 * Rechnung driftet. Die einzelnen `segments[].interestCents` sind je fuer sich gerundet
 * und dienen NUR der Anzeige (PDF-Zeile je Abschnitt) — nicht der Gesamtsumme.
 */
export function computeInterestSegments(input: ComputeInterestSegmentsInput): ComputeInterestSegmentsResult {
  const { openAmountCents, isConsumer, rates } = input;
  const pointsBp = (isConsumer ? 5 : 9) * 100;
  const totalDays = Math.max(0, daysBetween(input.from, input.to));

  if (totalDays === 0) {
    return { segments: [], interestCents: 0, baseRateBpWeighted: rateForDate(rates, input.from).rateBp, pointsBp };
  }

  // Grenzen strikt ZWISCHEN from und to — eine Grenze exakt auf `from` (Satzwechsel am
  // Faelligkeitstag) oder `to` schneidet keinen eigenen (leeren) Abschnitt ab; der Satz
  // zum jeweiligen Abschnittsbeginn (`rateForDate`) traegt sie ohnehin bereits mit.
  const boundaries = rates
    .map((r) => r.validFrom.getTime())
    .filter((t) => t > input.from.getTime() && t < input.to.getTime())
    .sort((a, b) => a - b);
  const cutTimes = [input.from.getTime(), ...boundaries, input.to.getTime()];

  let exactSum = 0;
  let weightedDaySum = 0;
  const segments: InterestSegment[] = [];
  for (let i = 0; i < cutTimes.length - 1; i++) {
    const segFrom = new Date(cutTimes[i]!);
    const segTo = new Date(cutTimes[i + 1]!);
    const days = daysBetween(segFrom, segTo);
    if (days <= 0) continue; // doppelte Grenze (kann bei identischem validFrom nicht vorkommen, defensiv)
    const baseRateBp = rateForDate(rates, segFrom).rateBp;
    const fraction = (openAmountCents * (baseRateBp + pointsBp) * days) / (10000 * 365);
    exactSum += fraction;
    weightedDaySum += baseRateBp * days;
    segments.push({
      from: segFrom.toISOString(),
      to: segTo.toISOString(),
      days,
      baseRateBp,
      pointsBp,
      interestCents: roundHalfUp(fraction),
    });
  }

  return {
    segments,
    interestCents: roundHalfUp(exactSum),
    baseRateBpWeighted: roundHalfUp(weightedDaySum / totalDays),
    pointsBp,
  };
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

export const DUNNING_LEVEL_TITLE: Record<number, string> = {
  0: "Zahlungserinnerung",
  1: "1. Mahnung",
  2: "2. Mahnung",
  3: "3. Mahnung",
};
