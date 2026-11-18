/**
 * Lesende Sicht auf den Kontoabruf fuer REST, MCP und Oberflaeche-nahe Auswertungen.
 * Gibt nie Zugangsdaten, Adresse, Produkt-ID, Kunden-ID, TAN-Medium oder Bankdaten aus; Kennung und IBAN nur maskiert.
 */
import { dbInternal } from "@/lib/db";
import { maskIban } from "@/lib/iban";
import type { Prisma } from "@/generated/prisma/client";
import { encodeSyncCursor, resolveSyncWindow, type SyncWindow } from "@/domain/sync/updated-since";
import { bankFetchRunListQuerySchema } from "@/schemas/bank-fetch";
import { loadBankFetchSettings } from "./settings";
import { scaRenewBy } from "./window";

/** Erste 2 + `***` + letzte 2 Zeichen; bis 4 Zeichen nur `***`. */
export function maskUserId(userId: string): string {
  const chars = Array.from(userId);
  if (chars.length <= 4) return "***";
  return `${chars.slice(0, 2).join("")}***${chars.slice(-2).join("")}`;
}

export interface BankFetchStatusAccount {
  id: string;
  ibanMasked: string;
  currency: string | null;
  selected: boolean;
  camtSupported: boolean;
  lastFetchedTo: Date | null;
}

export interface BankFetchStatusConnection {
  id: string;
  label: string;
  bankCode: string;
  state: string;
  pinMode: "PER_FETCH" | "STORED";
  autoEnabled: boolean;
  userIdMasked: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  scaRenewBy: Date | null;
  accounts: BankFetchStatusAccount[];
}

export interface BankFetchStatus {
  productIdConfigured: boolean;
  autoHour: number;
  connections: BankFetchStatusConnection[];
}

const CONNECTION_STATUS_SELECT = {
  id: true,
  label: true,
  bankCode: true,
  userId: true,
  pinMode: true,
  autoEnabled: true,
  state: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastScaAt: true,
  lastErrorCode: true,
  accounts: {
    orderBy: { iban: "asc" },
    select: { id: true, iban: true, currency: true, selected: true, camtSupported: true, lastFetchedTo: true },
  },
} as const satisfies Prisma.BankConnectionSelect;

export async function loadBankFetchStatus(orgId: string): Promise<BankFetchStatus> {
  const [settings, connections] = await Promise.all([
    loadBankFetchSettings(orgId),
    dbInternal.bankConnection.findMany({
      where: { orgId, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: CONNECTION_STATUS_SELECT,
    }),
  ]);
  return {
    productIdConfigured: settings.productIdConfigured,
    autoHour: settings.autoHour,
    connections: connections.map((c) => ({
      id: c.id,
      label: c.label,
      bankCode: c.bankCode,
      state: c.state,
      pinMode: c.pinMode === "STORED" ? "STORED" : "PER_FETCH",
      autoEnabled: c.autoEnabled,
      userIdMasked: maskUserId(c.userId),
      lastAttemptAt: c.lastAttemptAt,
      lastSuccessAt: c.lastSuccessAt,
      lastErrorCode: c.lastErrorCode,
      scaRenewBy: scaRenewBy(c.lastScaAt),
      accounts: c.accounts.map((a) => ({
        id: a.id,
        ibanMasked: maskIban(a.iban),
        currency: a.currency,
        selected: a.selected,
        camtSupported: a.camtSupported,
        lastFetchedTo: a.lastFetchedTo,
      })),
    })),
  };
}

const RUN_SELECT = {
  id: true,
  connectionId: true,
  accountId: true,
  account: { select: { iban: true } },
  trigger: true,
  startedAt: true,
  finishedAt: true,
  result: true,
  bankCodes: true,
  fromDate: true,
  toDate: true,
  documents: true,
  bytes: true,
  importId: true,
  importedCount: true,
  duplicateCount: true,
  scaUsed: true,
  createdAt: true,
} as const satisfies Prisma.BankFetchRunSelect;

type RunRaw = Prisma.BankFetchRunGetPayload<{ select: typeof RUN_SELECT }>;

export interface BankFetchRunRow {
  id: string;
  connectionId: string;
  accountId: string | null;
  ibanMasked: string | null;
  trigger: string;
  startedAt: Date;
  finishedAt: Date;
  result: string;
  bankCodes: string[];
  fromDate: Date | null;
  toDate: Date | null;
  documents: number;
  bytes: number;
  importId: string | null;
  importedCount: number;
  duplicateCount: number;
  scaUsed: boolean;
  createdAt: Date;
}

function toRunRow(r: RunRaw): BankFetchRunRow {
  const { account, bankCodes, ...rest } = r;
  return {
    ...rest,
    ibanMasked: account ? maskIban(account.iban) : null,
    // Nur vierstellige Rueckmeldecodes; alles andere wird verworfen.
    bankCodes: (bankCodes ?? "").split(",").map((c) => c.trim()).filter((c) => /^[0-9]{4}$/.test(c)),
  };
}

function syncWhereCreated(w: SyncWindow): Prisma.BankFetchRunWhereInput {
  const and: Prisma.BankFetchRunWhereInput[] = [{ createdAt: { gte: w.since } }];
  if (w.after) {
    and.push({ OR: [{ createdAt: { gt: w.after.updatedAt } }, { createdAt: w.after.updatedAt, id: { gt: w.after.id } }] });
  }
  return { AND: and };
}

/** Protokoll je Konto, neueste zuerst; mit `updatedSince` (= Anlagezeitpunkt) aufsteigend per Cursor. */
export async function listBankFetchRuns(
  orgId: string,
  raw: unknown,
): Promise<{ items: BankFetchRunRow[]; total: number; limit: number; offset: number; nextCursor: string | null }> {
  const q = bankFetchRunListQuerySchema.parse(raw);
  const window = resolveSyncWindow(raw, q);
  const base: Prisma.BankFetchRunWhereInput = { orgId, ...(q.connectionId ? { connectionId: q.connectionId } : {}) };
  const where: Prisma.BankFetchRunWhereInput = window ? { AND: [base, syncWhereCreated(window)] } : base;
  const totalWhere: Prisma.BankFetchRunWhereInput = window ? { AND: [base, { createdAt: { gte: window.since } }] } : base;
  const [total, rows] = await Promise.all([
    dbInternal.bankFetchRun.count({ where: totalWhere }),
    dbInternal.bankFetchRun.findMany({
      where,
      orderBy: window ? [{ createdAt: "asc" }, { id: "asc" }] : [{ startedAt: "desc" }, { id: "asc" }],
      take: q.limit,
      ...(window ? {} : { skip: q.offset }),
      select: RUN_SELECT,
    }),
  ]);
  const last = rows[rows.length - 1];
  const nextCursor = window && last && rows.length >= q.limit ? encodeSyncCursor({ updatedAt: last.createdAt, id: last.id }) : null;
  return { items: rows.map(toRunRow), total, limit: q.limit, offset: window ? 0 : q.offset, nextCursor };
}
