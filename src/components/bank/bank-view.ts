/**
 * Anzeigemodell des Bankabgleichs: serialisierbare Zeilen fuer die Client-Komponenten und reine Hilfsfunktionen
 * (Beschriftungen, Auswahl fuer die Sammelbestaetigung). Keine Datenbankzugriffe, keine IBAN im Klartext.
 */
import { maskIban } from "@/lib/iban";
import type { BankMatchRow, BankTransactionRow } from "@/domain/bank/list";
import type { Suggestion } from "@/domain/bank/match";
import type { ReturnSuggestion } from "@/domain/bank/return";

export type BankActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface BankMatchView {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  paymentId: string | null;
  amountCents: number;
  kind: string;
  refMatchId: string | null;
  reason: string | null;
  /** Zuordnung wurde per Gegenbuchung zurueckgenommen (ein UNDO-Eintrag verweist darauf). */
  undone: boolean;
}

export interface BankSuggestionView {
  allocations: Array<{ invoiceId: string; number: string; amountCents: number; applySkonto: boolean }>;
  confidence: "SICHER" | "MOEGLICH";
  reasons: string[];
  restCents: number;
}

export interface BankRowView {
  id: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  direction: "CRDT" | "DBIT";
  counterpartyName: string | null;
  /** Immer maskiert. */
  counterpartyIban: string | null;
  remittance: string;
  endToEndId: string | null;
  returnReason: string | null;
  status: string;
  allocatedCents: number;
  ignoredReason: string | null;
  matches: BankMatchView[];
  suggestions: BankSuggestionView[];
  returnSuggestions: ReturnSuggestion[];
}

export function toBankRowView(
  row: BankTransactionRow,
  matches: BankMatchRow[],
  suggestions: Suggestion[],
  returnSuggestions: ReturnSuggestion[],
): BankRowView {
  const undoneIds = new Set(matches.filter((m) => m.kind === "UNDO" && m.refMatchId).map((m) => m.refMatchId as string));
  return {
    id: row.id,
    bookingDate: row.bookingDate.toISOString(),
    amountCents: row.amountCents,
    currency: row.currency,
    direction: row.direction === "DBIT" ? "DBIT" : "CRDT",
    counterpartyName: row.counterpartyName,
    counterpartyIban: row.counterpartyIban ? maskIban(row.counterpartyIban) : null,
    remittance: row.remittance,
    endToEndId: row.endToEndId,
    returnReason: row.returnReason,
    status: row.status,
    allocatedCents: row.allocatedCents,
    ignoredReason: row.ignoredReason,
    matches: matches.map((m) => ({
      id: m.id,
      invoiceId: m.invoiceId,
      invoiceNumber: m.invoice.number,
      paymentId: m.paymentId,
      amountCents: m.amountCents,
      kind: m.kind,
      refMatchId: m.refMatchId,
      reason: m.reason,
      undone: undoneIds.has(m.id),
    })),
    suggestions: suggestions.map((s) => ({ allocations: s.allocations, confidence: s.confidence, reasons: s.reasons, restCents: s.restCents })),
    returnSuggestions,
  };
}

export const REASON_LABELS: Record<string, string> = {
  NUMBER: "Rechnungsnummer im Verwendungszweck",
  NUMBER_DIGITS: "Rechnungsnummer (Ziffern) im Verwendungszweck",
  AMOUNT: "Betrag passt",
  SKONTO: "Skonto",
  IBAN_HINT: "Bekanntes Gegenkonto",
  MANDATE_IBAN: "Konto des Lastschrift-Mandats",
  NAME: "Name passt",
  SPLIT: "Sammelzahlung mehrerer Rechnungen",
};

export const RETURN_REASON_LABELS: Record<ReturnSuggestion["reason"], string> = {
  SAME_E2E: "gleiche Ende-zu-Ende-Referenz",
  NUMBER: "Rechnungsnummer im Verwendungszweck",
};

export const IMPORT_WARNING_LABELS: Record<string, string> = {
  UNKNOWN_ACCOUNT: "Das Konto der Datei ist bisher nicht bekannt. Bitte prüfen, ob es das richtige Geschäftskonto ist.",
  MULTIPLE_ACCOUNTS: "Die Datei enthält mehrere Konten.",
  NOTHING_NEW: "Die Datei enthält keine neuen Umsätze.",
  NON_EUR: "Die Datei enthält Umsätze in Fremdwährung. Sie werden nur mit Rechnungen in derselben Währung zugeordnet.",
  RETURNS: "Die Datei enthält Rückbuchungen. Sie werden als „Rückbuchung – prüfen“ geführt und nie als Zahlung gebucht.",
};

export const SKIPPED_REASON_LABELS: Record<string, string> = {
  NOT_BOOKED: "nicht gebuchte Umsätze",
  OUTGOING: "Belastungen (werden nicht gespeichert)",
  RETURN_OF_OUTGOING: "Rückbuchungen zu eigenen Belastungen",
  ZERO_AMOUNT: "Umsätze ohne Betrag",
};

export function skippedReasonLabel(code: string): string {
  return SKIPPED_REASON_LABELS[code] ?? code;
}

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code;
}

/** Offener Betrag des Umsatzes (nie negativ). */
export function restCents(row: Pick<BankRowView, "amountCents" | "allocatedCents">): number {
  return Math.max(0, row.amountCents - row.allocatedCents);
}

/** Der eine eindeutige Vorschlag (genau ein SICHER-Vorschlag, ohne Skonto-Abzug) eines offenen Umsatzes, sonst `null`. */
function uniqueSure(row: BankRowView): BankSuggestionView | null {
  if (row.status !== "OPEN" || row.direction !== "CRDT") return null;
  const sure = row.suggestions.filter((s) => s.confidence === "SICHER");
  if (sure.length !== 1) return null;
  return sure[0]!.allocations.some((a) => a.applySkonto) ? null : sure[0]!;
}

/** Umsaetze der Seite fuer die Sammelbestaetigung. Rueckbuchungen (RETURN) und Skonto-Faelle sind nie dabei. */
export function bulkEligibleIds(rows: BankRowView[]): string[] {
  return rows.filter((r) => uniqueSure(r) !== null).map((r) => r.id);
}

/** Eindeutige Vorschlaege, die nur mit Skonto-Abzug passen; sie muessen einzeln bestaetigt werden. */
export function skontoOnlyCount(rows: BankRowView[]): number {
  return rows.filter((r) => {
    if (r.status !== "OPEN" || r.direction !== "CRDT") return false;
    const sure = r.suggestions.filter((s) => s.confidence === "SICHER");
    return sure.length === 1 && sure[0]!.allocations.some((a) => a.applySkonto);
  }).length;
}

/** Summe der Zuordnungszeilen ueberschreitet den freien Betrag (Hinweis im Dialog; der Server prueft erneut). */
export function exceedsRest(allocationCents: number[], rest: number): boolean {
  return allocationCents.reduce((s, c) => s + c, 0) > rest;
}

/** Hinweise nach einer Gegenbuchung: Rueckgabegebuehr (wird nie gebucht) und Teil-Gegenbuchung. */
export function describeReturnResult(r: { feeCents: number; partial: boolean }, currency: string, formatter: (cents: number, currency: string) => string): string[] {
  const out = ["Gegenbuchung gebucht."];
  if (r.partial) out.push("Nur ein Teil der Zahlung wurde gegengebucht: Die Rückbuchung war kleiner als der Rest der Zahlung.");
  if (r.feeCents > 0) out.push(`Rückgabegebühr der Bank: ${formatter(r.feeCents, currency)} (wird nicht gebucht).`);
  return out;
}
