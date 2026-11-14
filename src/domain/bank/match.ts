/**
 * Zuordnungsvorschlaege fuer Bankumsaetze. Rein und deterministisch, ohne Datenbankzugriff.
 * Es wird nie gebucht: das Ergebnis sind nur Vorschlaege, die ein Mensch bestaetigt.
 */
import { detectSkonto, type SkontoTerm } from "@/lib/pricing/skonto";

export interface OpenInvoiceForMatch {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  currency: string;
  /** Offener Rest in Cent, immer > 0. */
  openCents: number;
  issueDate: Date;
  dueDate: Date | null;
  skontoTerms: SkontoTerm[];
  /** HMAC der Mandats-IBAN des Kunden, falls hinterlegt. */
  mandateIbanHash: string | null;
}

export interface MatchTransaction {
  bookingDate: Date;
  amountCents: number;
  allocatedCents: number;
  currency: string;
  direction: string;
  counterpartyName: string | null;
  /** HMAC der normalisierten Gegenkonto-IBAN (nie Klartext). */
  counterpartyIbanHash: string | null;
  remittance: string;
  endToEndId: string | null;
}

export interface MatchContext {
  invoices: OpenInvoiceForMatch[];
  /** ibanHash -> customerId */
  hints: Map<string, string>;
}

export type SuggestionReason = "NUMBER" | "NUMBER_DIGITS" | "AMOUNT" | "SKONTO" | "IBAN_HINT" | "MANDATE_IBAN" | "NAME" | "SPLIT";

export interface Suggestion {
  allocations: Array<{ invoiceId: string; number: string; amountCents: number; applySkonto: boolean }>;
  score: number;
  confidence: "SICHER" | "MOEGLICH";
  reasons: SuggestionReason[];
  restCents: number;
}

const SCORE_NUMBER = 100;
const SCORE_DIGITS = 60;
const SCORE_AMOUNT = 30;
const SCORE_SKONTO = 25;
const SCORE_IBAN = 30;
const SCORE_NAME = 10;
const SCORE_SPLIT = 50;
const MIN_DIGITS = 4;
const MIN_NUMBER_LENGTH = 3;
const MAX_SPLIT = 50;
const NAME_THRESHOLD = 0.5;
const NAME_STOPWORDS = new Set(["gmbh", "mbh", "ag", "kg", "ug", "ohg", "gbr", "se", "co", "und", "e", "v", "ev", "inc", "ltd", "the"]);

const REASON_ORDER: readonly SuggestionReason[] = ["SPLIT", "NUMBER", "NUMBER_DIGITS", "AMOUNT", "SKONTO", "IBAN_HINT", "MANDATE_IBAN", "NAME"];

/** Grossbuchstaben und Ziffern, alles andere faellt weg. */
export function normalizeRef(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** Volle Belegnummern im Text; ein Treffer darf im Originaltext nicht von weiteren Ziffern umschlossen sein. */
export function findInvoiceNumbers(text: string, numbers: readonly string[]): string[] {
  const upper = text.toUpperCase();
  let haystack = "";
  const origin: number[] = [];
  for (let i = 0; i < upper.length; i++) {
    const c = upper[i]!;
    if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) {
      haystack += c;
      origin.push(i);
    }
  }
  const found: string[] = [];
  for (const number of numbers) {
    const needle = normalizeRef(number);
    if (needle.length < MIN_NUMBER_LENGTH) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const before = upper[origin[at]! - 1];
      const after = upper[origin[at + needle.length - 1]! + 1];
      if (!isDigit(before) && !isDigit(after)) {
        found.push(number);
        break;
      }
      from = at + 1;
    }
  }
  return found;
}

function digitsReference(text: string, number: string): boolean {
  const digits = number.replace(/\D/g, "");
  if (digits.length < MIN_DIGITS) return false;
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(text.toUpperCase());
}

function nameTokens(s: string | null): Set<string> {
  if (!s) return new Set();
  const tokens = s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !NAME_STOPWORDS.has(t));
  return new Set(tokens);
}

function nameMatches(a: string | null, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size) >= NAME_THRESHOLD;
}

interface Candidate {
  invoice: OpenInvoiceForMatch;
  level: "NUMBER" | "NUMBER_DIGITS" | null;
  amount: boolean;
  skonto: boolean;
  iban: "IBAN_HINT" | "MANDATE_IBAN" | null;
  name: boolean;
}

function compareDue(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function reasonsOf(set: Set<SuggestionReason>): SuggestionReason[] {
  return REASON_ORDER.filter((r) => set.has(r));
}

function rankKey(s: Suggestion): string {
  return s.allocations.map((a) => a.invoiceId).join(",");
}

/**
 * Vorschlaege fuer einen Umsatz, bestes zuerst. Nur Gutschriften (CRDT) mit Restbetrag und nur offene
 * Rechnungen gleicher Waehrung. "SICHER" nur bei genau einer vollen Belegnummer mit passendem Betrag
 * (offener Rest oder Skontobetrag) oder bei einer Sammelzahlung aus lauter vollen Nummern.
 */
export function suggestMatches(tx: MatchTransaction, ctx: MatchContext, max = 5): Suggestion[] {
  const txRest = tx.amountCents - tx.allocatedCents;
  if (tx.direction !== "CRDT" || txRest <= 0 || max <= 0) return [];

  const invoices = ctx.invoices
    .filter((i) => i.currency === tx.currency && i.openCents > 0)
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (invoices.length === 0) return [];

  const text = `${tx.remittance} ${tx.endToEndId ?? ""}`;
  const fullNumbers = new Set(findInvoiceNumbers(text, invoices.map((i) => i.number)));
  const hintCustomer = tx.counterpartyIbanHash ? ctx.hints.get(tx.counterpartyIbanHash) : undefined;

  const candidates: Candidate[] = [];
  for (const invoice of invoices) {
    const level = fullNumbers.has(invoice.number) ? "NUMBER" : digitsReference(text, invoice.number) ? "NUMBER_DIGITS" : null;
    const amount = txRest === invoice.openCents;
    const skonto = !amount && detectSkonto(invoice.skontoTerms, tx.bookingDate, txRest, invoice.openCents) !== null;
    let iban: Candidate["iban"] = null;
    if (hintCustomer !== undefined && hintCustomer === invoice.customerId) iban = "IBAN_HINT";
    else if (tx.counterpartyIbanHash && invoice.mandateIbanHash === tx.counterpartyIbanHash) iban = "MANDATE_IBAN";
    const name = nameMatches(tx.counterpartyName, invoice.customerName);
    if (level === null && !((amount || skonto) && (iban !== null || name))) continue;
    candidates.push({ invoice, level, amount, skonto, iban, name });
  }

  const result: Suggestion[] = [];
  const fullCount = candidates.filter((c) => c.level === "NUMBER").length;

  for (const c of candidates) {
    const reasons = new Set<SuggestionReason>();
    let score = 0;
    if (c.level === "NUMBER") {
      reasons.add("NUMBER");
      score += SCORE_NUMBER;
    } else if (c.level === "NUMBER_DIGITS") {
      reasons.add("NUMBER_DIGITS");
      score += SCORE_DIGITS;
    }
    if (c.amount) {
      reasons.add("AMOUNT");
      score += SCORE_AMOUNT;
    } else if (c.skonto) {
      reasons.add("SKONTO");
      score += SCORE_SKONTO;
    }
    if (c.iban) {
      reasons.add(c.iban);
      score += SCORE_IBAN;
    }
    if (c.name) {
      reasons.add("NAME");
      score += SCORE_NAME;
    }
    const amountCents = Math.min(c.invoice.openCents, txRest);
    const sure = c.level === "NUMBER" && fullCount === 1 && (c.amount || c.skonto);
    result.push({
      allocations: [{ invoiceId: c.invoice.id, number: c.invoice.number, amountCents, applySkonto: c.skonto }],
      score,
      confidence: sure ? "SICHER" : "MOEGLICH",
      reasons: reasonsOf(reasons),
      restCents: txRest - amountCents,
    });
  }

  const split = buildSplit(candidates, txRest);
  if (split) result.push(split);

  return result
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareDue(dueOf(a, invoices), dueOf(b, invoices)) ||
        (a.allocations[0]!.number < b.allocations[0]!.number ? -1 : a.allocations[0]!.number > b.allocations[0]!.number ? 1 : 0) ||
        (rankKey(a) < rankKey(b) ? -1 : rankKey(a) > rankKey(b) ? 1 : 0),
    )
    .slice(0, max);
}

function dueOf(s: Suggestion, invoices: readonly OpenInvoiceForMatch[]): Date | null {
  const first = s.allocations[0];
  return invoices.find((i) => i.id === first?.invoiceId)?.dueDate ?? null;
}

/** Sammelzahlung: mehrere Nummern im Text, deren offene Reste zusammen den Umsatzrest ergeben. */
function buildSplit(candidates: readonly Candidate[], txRest: number): Suggestion | null {
  const sum = (cs: readonly Candidate[]): number => cs.reduce((s, c) => s + c.invoice.openCents, 0);
  const full = candidates.filter((c) => c.level === "NUMBER");
  const numbered = candidates.filter((c) => c.level !== null);
  let members: Candidate[] | null = null;
  let sure = false;
  if (full.length >= 2 && full.length <= MAX_SPLIT && sum(full) === txRest) {
    members = full;
    sure = true;
  } else if (numbered.length >= 2 && numbered.length <= MAX_SPLIT && sum(numbered) === txRest) {
    members = numbered;
  }
  if (!members) return null;
  const reasons = new Set<SuggestionReason>(["SPLIT"]);
  let score = SCORE_SPLIT;
  for (const m of members) {
    score += m.level === "NUMBER" ? SCORE_NUMBER / members.length : SCORE_DIGITS / members.length;
    reasons.add(m.level === "NUMBER" ? "NUMBER" : "NUMBER_DIGITS");
    if (m.iban) reasons.add(m.iban);
    if (m.name) reasons.add("NAME");
  }
  if (sure) reasons.delete("NUMBER_DIGITS");
  return {
    allocations: members.map((m) => ({ invoiceId: m.invoice.id, number: m.invoice.number, amountCents: m.invoice.openCents, applySkonto: false })),
    score: Math.round(score),
    confidence: sure ? "SICHER" : "MOEGLICH",
    reasons: reasonsOf(reasons),
    restCents: 0,
  };
}
