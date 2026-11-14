import { describe, expect, it } from "vitest";
import { suggestMatches, type MatchContext, type MatchTransaction, type OpenInvoiceForMatch } from "@/domain/bank/match";

/** Kleiner seeded PRNG (mulberry32), keine zusaetzliche Abhaengigkeit. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

function scenario(seed: number): { tx: MatchTransaction; invoices: OpenInvoiceForMatch[]; hints: Array<[string, string]> } {
  const r = prng(seed);
  const n = int(r, 0, 8);
  const invoices: OpenInvoiceForMatch[] = [];
  for (let i = 0; i < n; i++) {
    const num = 50000 + int(r, 0, 30);
    invoices.push({
      id: `i${i}`,
      number: `RE-${num}${i}`,
      customerId: pick(r, ["c1", "c2"]),
      customerName: pick(r, ["Muster Kundschaft GmbH", "Beispiel Handel AG"]),
      currency: pick(r, ["EUR", "EUR", "USD"]),
      openCents: int(r, 1, 5) * 1000,
      issueDate: new Date("2200-05-01T00:00:00.000Z"),
      dueDate: r() < 0.2 ? null : new Date(Date.UTC(2200, 5, int(r, 1, 28))),
      skontoTerms: [],
      mandateIbanHash: r() < 0.3 ? "h1" : null,
    });
  }
  const refs = invoices
    .filter(() => r() < 0.5)
    .map((i) => (r() < 0.5 ? i.number : i.number.replace(/\D/g, "")))
    .join(r() < 0.5 ? " " : ", ");
  const amount = r() < 0.4 && invoices[0] ? invoices[0].openCents : int(r, 1, 20) * 500;
  const tx: MatchTransaction = {
    bookingDate: new Date("2200-05-10T00:00:00.000Z"),
    amountCents: amount,
    allocatedCents: r() < 0.2 ? int(r, 0, Math.max(0, amount - 1)) : 0,
    currency: pick(r, ["EUR", "EUR", "USD"]),
    direction: r() < 0.9 ? "CRDT" : "DBIT",
    counterpartyName: r() < 0.5 ? "Muster Kundschaft" : null,
    counterpartyIbanHash: r() < 0.5 ? "h1" : null,
    remittance: refs,
    endToEndId: null,
  };
  return { tx, invoices, hints: r() < 0.5 ? [["h1", "c1"]] : [] };
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = prng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("suggestMatches Invarianten (500 Laeufe)", () => {
  it("haelt alle Invarianten ein", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { tx, invoices, hints } = scenario(seed);
      const ctx: MatchContext = { invoices, hints: new Map(hints) };
      const out = suggestMatches(tx, ctx, 5);
      const txRest = tx.amountCents - tx.allocatedCents;
      const byId = new Map(invoices.map((i) => [i.id, i]));
      expect(out.length).toBeLessThanOrEqual(5);
      for (const s of out) {
        let sum = 0;
        for (const a of s.allocations) {
          const i = byId.get(a.invoiceId)!;
          expect(i.currency).toBe(tx.currency);
          expect(a.amountCents).toBeGreaterThan(0);
          expect(a.amountCents).toBeLessThanOrEqual(i.openCents);
          sum += a.amountCents;
        }
        expect(sum).toBeLessThanOrEqual(txRest);
        expect(s.restCents).toBe(txRest - sum);
        if (s.confidence === "SICHER") expect(s.reasons).toContain("NUMBER");
      }
      if (tx.direction !== "CRDT" || txRest <= 0) expect(out).toEqual([]);
      expect(suggestMatches(tx, { invoices: shuffled(invoices, seed + 9000), hints: new Map(hints) }, 5)).toEqual(out);
    }
  });
});
