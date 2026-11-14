/**
 * Lesende Abfragen des Bankabgleichs fuer REST und MCP (Importe, Umsaetze, Umsatz mit Zuordnungen).
 * Cursor = Id der letzten Zeile; ein fremder oder unbekannter Cursor ist ein Validierungsfehler.
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { bankListQuerySchema } from "@/schemas/bank";
import type { Prisma } from "@/generated/prisma/client";

export const BANK_STATEMENT_SELECT = {
  id: true,
  fileName: true,
  format: true,
  schemaVersion: true,
  accountIban: true,
  statementId: true,
  periodFrom: true,
  periodTo: true,
  entryCount: true,
  importedCount: true,
  duplicateCount: true,
  skippedCount: true,
  warningsJson: true,
  createdBy: true,
  createdAt: true,
} as const satisfies Prisma.BankStatementImportSelect;

export const BANK_TRANSACTION_SELECT = {
  id: true,
  importId: true,
  accountIban: true,
  bookingDate: true,
  valueDate: true,
  amountCents: true,
  currency: true,
  direction: true,
  counterpartyName: true,
  counterpartyIban: true,
  remittance: true,
  endToEndId: true,
  bankTxCode: true,
  returnReason: true,
  status: true,
  allocatedCents: true,
  ignoredReason: true,
  ignoredAt: true,
  createdAt: true,
} as const satisfies Prisma.BankTransactionSelect;

export const BANK_MATCH_SELECT = {
  id: true,
  invoiceId: true,
  paymentId: true,
  amountCents: true,
  kind: true,
  refMatchId: true,
  reason: true,
  confirmedBy: true,
  confirmedAt: true,
  invoice: { select: { number: true } },
} as const satisfies Prisma.BankMatchSelect;

export type BankStatementRow = Prisma.BankStatementImportGetPayload<{ select: typeof BANK_STATEMENT_SELECT }>;
export type BankTransactionRow = Prisma.BankTransactionGetPayload<{ select: typeof BANK_TRANSACTION_SELECT }>;
export type BankMatchRow = Prisma.BankMatchGetPayload<{ select: typeof BANK_MATCH_SELECT }>;

const cursorError = () => new z.ZodError([{ code: "custom", path: ["cursor"], message: "Ungueltiger Cursor." }]);

export const bankStatementListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export async function listBankImports(
  orgId: string,
  raw: unknown,
): Promise<{ rows: BankStatementRow[]; total: number; limit: number; nextCursor: string | null }> {
  const q = bankStatementListQuerySchema.parse(raw ?? {});
  if (q.cursor && !(await dbInternal.bankStatementImport.findFirst({ where: { id: q.cursor, orgId }, select: { id: true } }))) throw cursorError();
  const [total, rows] = await Promise.all([
    dbInternal.bankStatementImport.count({ where: { orgId } }),
    dbInternal.bankStatementImport.findMany({
      where: { orgId },
      select: BANK_STATEMENT_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
  ]);
  const page = rows.slice(0, q.limit);
  return { rows: page, total, limit: q.limit, nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export async function listBankTransactions(
  orgId: string,
  raw: unknown,
): Promise<{ rows: BankTransactionRow[]; total: number; limit: number; nextCursor: string | null }> {
  const q = bankListQuerySchema.parse(raw ?? {});
  const where: Prisma.BankTransactionWhereInput = {
    orgId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.from || q.to ? { bookingDate: { ...(q.from ? { gte: dayStart(q.from) } : {}), ...(q.to ? { lte: dayStart(q.to) } : {}) } } : {}),
  };
  if (q.cursor && !(await dbInternal.bankTransaction.findFirst({ where: { id: q.cursor, orgId }, select: { id: true } }))) throw cursorError();
  const [total, rows] = await Promise.all([
    dbInternal.bankTransaction.count({ where }),
    dbInternal.bankTransaction.findMany({
      where,
      select: BANK_TRANSACTION_SELECT,
      orderBy: [{ bookingDate: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
  ]);
  const page = rows.slice(0, q.limit);
  return { rows: page, total, limit: q.limit, nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

export async function getBankTransaction(orgId: string, id: string): Promise<{ transaction: BankTransactionRow; matches: BankMatchRow[] }> {
  const transaction = await dbInternal.bankTransaction.findFirst({ where: { id, orgId }, select: BANK_TRANSACTION_SELECT });
  if (!transaction) throw new NotFoundError("Bankumsatz nicht gefunden.");
  const matches = await dbInternal.bankMatch.findMany({
    where: { orgId, transactionId: id },
    select: BANK_MATCH_SELECT,
    orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  return { transaction, matches };
}

export const BANK_TABS = ["OPEN", "PARTIAL", "MATCHED", "IGNORED", "RETURN"] as const;
export type BankTab = (typeof BANK_TABS)[number];
export const BANK_PAGE_SIZE = 50;

/** Der Reiter „Rueckgaben" fasst offene und erledigte Rueckbuchungen zusammen. */
const TAB_STATUSES: Record<BankTab, string[]> = {
  OPEN: ["OPEN"],
  PARTIAL: ["PARTIAL"],
  MATCHED: ["MATCHED"],
  IGNORED: ["IGNORED"],
  RETURN: ["RETURN", "RETURN_DONE"],
};

export interface BankPage {
  rows: BankTransactionRow[];
  matches: Array<BankMatchRow & { transactionId: string }>;
  total: number;
  page: number;
  pageCount: number;
  counts: Record<BankTab, number>;
}

/** Eine Seite Umsaetze fuer die Oberflaeche (50 je Seite) samt Zuordnungen und Zaehlern je Reiter. */
export async function listBankPage(orgId: string, tab: BankTab, page: number): Promise<BankPage> {
  const grouped = await dbInternal.bankTransaction.groupBy({ by: ["status"], where: { orgId }, _count: { _all: true } });
  const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
  const counts = Object.fromEntries(BANK_TABS.map((t) => [t, TAB_STATUSES[t].reduce((s, st) => s + (byStatus.get(st) ?? 0), 0)])) as Record<BankTab, number>;
  const total = counts[tab];
  const pageCount = Math.max(1, Math.ceil(total / BANK_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const rows = await dbInternal.bankTransaction.findMany({
    where: { orgId, status: { in: TAB_STATUSES[tab] } },
    select: BANK_TRANSACTION_SELECT,
    orderBy: [{ bookingDate: "desc" }, { id: "desc" }],
    take: BANK_PAGE_SIZE,
    skip: (current - 1) * BANK_PAGE_SIZE,
  });
  const matches =
    rows.length === 0
      ? []
      : await dbInternal.bankMatch.findMany({
          where: { orgId, transactionId: { in: rows.map((r) => r.id) } },
          select: { ...BANK_MATCH_SELECT, transactionId: true },
          orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
          take: 2000,
        });
  return { rows, matches, total, page: current, pageCount, counts };
}
