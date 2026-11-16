/**
 * Skonto aus der Zahlungsbedingung (BT-20) einer Eingangsrechnung: Zeilen `#SKONTO#TAGE=n#PROZENT=p#`
 * (optional `#BASISBETRAG=b#`). Prozent als Basispunkte, Betraege per BigInt Half-Up in Cent.
 */
import { MAX_SKONTO_DAYS, MAX_SKONTO_TERMS } from "./limits";

export interface SkontoTerm {
  days: number;
  percentBp: number;
  basisCents: number | null;
}

const LINE = /^#SKONTO#TAGE=(\d{1,3})#PROZENT=(\d{1,3}(?:\.\d{1,2})?)(?:#BASISBETRAG=(\d{1,10}(?:\.\d{1,2})?))?#$/;

/** "2.5" -> 250 (Basispunkte), "100.00" -> 10000 (Cent); beide mit hoechstens 2 Nachkommastellen. */
function scale100(s: string): number {
  const [int, frac = ""] = s.split(".");
  return Number(int) * 100 + Number(frac.padEnd(2, "0"));
}

export function parseSkontoTerms(terms: string | null): { terms: SkontoTerm[]; freeText: string | null } {
  if (terms === null) return { terms: [], freeText: null };
  const found: SkontoTerm[] = [];
  const rest: string[] = [];
  for (const raw of terms.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (m && found.length < MAX_SKONTO_TERMS) {
      const days = Number(m[1]);
      const percentBp = scale100(m[2]);
      if (days >= 1 && days <= MAX_SKONTO_DAYS && percentBp > 0 && percentBp <= 10_000) {
        found.push({ days, percentBp, basisCents: m[3] === undefined ? null : scale100(m[3]) });
        continue;
      }
    }
    rest.push(raw);
  }
  const free = rest.join("\n").trim();
  return { terms: found, freeText: free === "" ? null : free };
}

function addDays(isoDay: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export function skontoSchedule(
  terms: SkontoTerm[],
  issueDate: string | null,
  payableCents: number | null,
): { until: string; percentBp: number; discountCents: number; payCents: number }[] {
  if (issueDate === null) return [];
  const out: { until: string; percentBp: number; discountCents: number; payCents: number }[] = [];
  for (const t of terms) {
    const until = addDays(issueDate, t.days);
    const basis = t.basisCents ?? payableCents;
    if (until === null || basis === null || payableCents === null) continue;
    const discount = Number((BigInt(basis) * BigInt(t.percentBp) + BigInt(5000)) / BigInt(10000));
    out.push({ until, percentBp: t.percentBp, discountCents: discount, payCents: payableCents - discount });
  }
  return out;
}
