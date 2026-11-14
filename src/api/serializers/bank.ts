import "../openapi-zod-init";
import { z } from "zod";
import { maskIban } from "@/lib/iban";
import { iso } from "./common";
import type { BankMatchRow, BankStatementRow, BankTransactionRow } from "@/domain/bank/list";
import type { BankImportResult } from "@/domain/bank/import";
import type { ConfirmResult, BankTransactionView } from "@/domain/bank/confirm";

/** IBAN nie im Klartext ausgeben; Fingerabdruck und Dateihash sind nie Teil der Ausgabe. */
function maskedOrNull(iban: string | null): string | null {
  return iban ? maskIban(iban) : null;
}

function warnings(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function serializeBankStatement(r: BankStatementRow) {
  return {
    objectName: "BankStatementImport" as const,
    id: r.id,
    fileName: r.fileName,
    format: r.format,
    schemaVersion: r.schemaVersion,
    accountIban: maskedOrNull(r.accountIban),
    statementId: r.statementId,
    periodFrom: iso(r.periodFrom),
    periodTo: iso(r.periodTo),
    entryCount: r.entryCount,
    importedCount: r.importedCount,
    duplicateCount: r.duplicateCount,
    skippedCount: r.skippedCount,
    warnings: warnings(r.warningsJson),
    createdBy: r.createdBy,
    createdAt: iso(r.createdAt),
  };
}

export function serializeBankTransaction(r: BankTransactionRow) {
  return {
    objectName: "BankTransaction" as const,
    id: r.id,
    importId: r.importId,
    accountIban: maskIban(r.accountIban),
    bookingDate: iso(r.bookingDate),
    valueDate: iso(r.valueDate),
    amountCents: r.amountCents,
    currency: r.currency,
    direction: r.direction as "CRDT" | "DBIT",
    counterpartyName: r.counterpartyName,
    counterpartyIban: maskedOrNull(r.counterpartyIban),
    remittance: r.remittance,
    endToEndId: r.endToEndId,
    bankTxCode: r.bankTxCode,
    returnReason: r.returnReason,
    status: r.status,
    allocatedCents: r.allocatedCents,
    ignoredReason: r.ignoredReason,
    ignoredAt: iso(r.ignoredAt),
    createdAt: iso(r.createdAt),
  };
}

export function serializeBankMatch(m: BankMatchRow) {
  return {
    objectName: "BankMatch" as const,
    id: m.id,
    invoiceId: m.invoiceId,
    invoiceNumber: m.invoice.number,
    paymentId: m.paymentId,
    amountCents: m.amountCents,
    kind: m.kind,
    refMatchId: m.refMatchId,
    reason: m.reason,
    confirmedBy: m.confirmedBy,
    confirmedAt: iso(m.confirmedAt),
  };
}

export function serializeBankImportResult(r: BankImportResult) {
  return {
    status: r.status,
    importId: r.importId,
    format: r.format,
    schemaVersion: r.schemaVersion,
    accountIban: r.accountIban,
    entryCount: r.entryCount,
    importedCount: r.importedCount,
    duplicateCount: r.duplicateCount,
    skippedCount: r.skippedCount,
    skippedReasons: r.skippedReasons,
    returnCount: r.returnCount,
    warnings: r.warnings as string[],
    duplicateOf: r.duplicateOf ? { importId: r.duplicateOf.importId, importedAt: iso(r.duplicateOf.importedAt) } : null,
  };
}

export function serializeBankView(v: BankTransactionView) {
  return {
    id: v.id,
    status: v.status,
    direction: v.direction,
    amountCents: v.amountCents,
    allocatedCents: v.allocatedCents,
    currency: v.currency,
    bookingDate: iso(v.bookingDate),
    ignoredReason: v.ignoredReason,
  };
}

export function serializeConfirmResult(r: ConfirmResult) {
  return { transaction: serializeBankView(r.transaction), payments: r.payments };
}

// ── OpenAPI-Schemas ──────────────────────────────────────────────────────────────
export const bankStatementSchema = z.object({
  objectName: z.literal("BankStatementImport"),
  id: z.string(),
  fileName: z.string().nullable(),
  format: z.string(),
  schemaVersion: z.string(),
  accountIban: z.string().nullable().describe("Maskiert"),
  statementId: z.string().nullable(),
  periodFrom: z.string().nullable(),
  periodTo: z.string().nullable(),
  entryCount: z.number().int(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  skippedCount: z.number().int(),
  warnings: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string().nullable(),
});

export const bankTransactionSchema = z.object({
  objectName: z.literal("BankTransaction"),
  id: z.string(),
  importId: z.string(),
  accountIban: z.string().describe("Maskiert"),
  bookingDate: z.string().nullable(),
  valueDate: z.string().nullable(),
  amountCents: z.number().int().describe("Immer positiv; die Richtung steht in direction"),
  currency: z.string(),
  direction: z.enum(["CRDT", "DBIT"]),
  counterpartyName: z.string().nullable(),
  counterpartyIban: z.string().nullable().describe("Maskiert"),
  remittance: z.string(),
  endToEndId: z.string().nullable(),
  bankTxCode: z.string().nullable(),
  returnReason: z.string().nullable(),
  status: z.string().describe("OPEN | PARTIAL | MATCHED | IGNORED | RETURN | RETURN_DONE"),
  allocatedCents: z.number().int(),
  ignoredReason: z.string().nullable(),
  ignoredAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const bankMatchSchema = z.object({
  objectName: z.literal("BankMatch"),
  id: z.string(),
  invoiceId: z.string(),
  invoiceNumber: z.string().nullable(),
  paymentId: z.string().nullable(),
  amountCents: z.number().int(),
  kind: z.string().describe("PAYMENT | SKONTO | REVERSAL | UNDO"),
  refMatchId: z.string().nullable(),
  reason: z.string().nullable(),
  confirmedBy: z.string(),
  confirmedAt: z.string().nullable(),
});

export const bankTransactionDetailSchema = z.object({ transaction: bankTransactionSchema, matches: z.array(bankMatchSchema) });

export const bankImportResultSchema = z.object({
  status: z.enum(["preview", "imported"]),
  importId: z.string().nullable(),
  format: z.string(),
  schemaVersion: z.string(),
  accountIban: z.string().describe("Maskiert"),
  entryCount: z.number().int(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  skippedCount: z.number().int(),
  skippedReasons: z.record(z.string(), z.number().int()),
  returnCount: z.number().int(),
  warnings: z.array(z.string()),
  duplicateOf: z.object({ importId: z.string(), importedAt: z.string().nullable() }).nullable(),
});

export const bankViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  direction: z.string(),
  amountCents: z.number().int(),
  allocatedCents: z.number().int(),
  currency: z.string(),
  bookingDate: z.string().nullable(),
  ignoredReason: z.string().nullable(),
});

export const bankConfirmResultSchema = z.object({
  transaction: bankViewSchema,
  payments: z.array(z.object({ invoiceId: z.string(), paymentId: z.string(), skontoPaymentId: z.string().optional() })),
});

export const bankUnambiguousResultSchema = z.object({
  confirmed: z.number().int(),
  skipped: z.array(z.object({ transactionId: z.string(), reason: z.string() })),
  truncated: z.boolean(),
  remaining: z.number().int(),
});

export const bankReturnResultSchema = bankViewSchema.extend({
  feeCents: z.number().int(),
  partial: z.boolean(),
});

export function serializeBankReturnResult(r: { transaction: Parameters<typeof serializeBankView>[0]; feeCents: number; partial: boolean }): z.infer<typeof bankReturnResultSchema> {
  return { ...serializeBankView(r.transaction), feeCents: r.feeCents, partial: r.partial };
}

export const bankSuggestionSchema = z.object({
  allocations: z.array(z.object({ invoiceId: z.string(), number: z.string(), amountCents: z.number().int(), applySkonto: z.boolean() })),
  score: z.number(),
  confidence: z.enum(["SICHER", "MOEGLICH"]),
  reasons: z.array(z.string()),
  restCents: z.number().int(),
});

export const bankReturnSuggestionSchema = z.object({
  paymentId: z.string(),
  invoiceId: z.string(),
  number: z.string(),
  amountCents: z.number().int(),
  reason: z.enum(["SAME_E2E", "NUMBER"]),
});

export const bankSuggestionsResultSchema = z.object({
  suggestions: z.array(bankSuggestionSchema),
  returnSuggestions: z.array(bankReturnSuggestionSchema),
});
