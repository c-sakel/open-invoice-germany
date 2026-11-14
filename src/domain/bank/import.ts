/**
 * Kontoauszug-Import (CAMT.053/.054) mit Vorschau. Schutz vor Doppelimport ueber den Datei-Hash
 * (je Organisation) und je Umsatz ueber den Fingerabdruck. Es wird nichts gebucht; Umsaetze landen
 * als OPEN (bzw. RETURN bei Rueckgaben) in der Warteschlange.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { maskIban, normalizeIban } from "@/lib/iban";
import { rateLimit } from "@/lib/rate-limit";
import { logActivity } from "@/domain/activity/log";
import { sanitizeFileName } from "@/domain/import/types";
import { decodeCamtBytes } from "./camt-xml";
import { parseCamt, type ParsedTransaction } from "./camt-parse";
import { transactionFingerprints } from "./fingerprint";
import { CamtFormatError, MAX_STORED_TX } from "./errors";

export class BankImportDuplicateError extends Error {
  readonly status = 409;
  constructor(
    readonly importId: string,
    readonly importedAt: Date,
  ) {
    super("Diese Datei wurde bereits importiert.");
    this.name = "BankImportDuplicateError";
  }
}

export type BankImportWarning = "UNKNOWN_ACCOUNT" | "MULTIPLE_ACCOUNTS" | "NOTHING_NEW";

export interface BankImportResult {
  status: "preview" | "imported";
  importId: string | null;
  format: string;
  schemaVersion: string;
  /** Maskiert (Konto der ersten Meldung). */
  accountIban: string;
  entryCount: number;
  importedCount: number;
  duplicateCount: number;
  skippedCount: number;
  warnings: BankImportWarning[];
}

export interface BankImportOptions {
  actor: string;
  source: "UI" | "API" | "MCP";
  fileName?: string;
  dryRun?: boolean;
  now?: Date;
}

const BLOCK = 500;
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

interface PlannedTx {
  accountIban: string;
  fingerprint: string;
  tx: ParsedTransaction;
}

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type Db = Pick<typeof dbInternal, "bankTransaction" | "bankStatementImport" | "organization" | "paymentMethod">;

async function loadExisting(db: Db, orgId: string, fingerprints: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const block of chunks(fingerprints, BLOCK)) {
    const rows = await db.bankTransaction.findMany({
      where: { orgId, fingerprint: { in: block } },
      select: { fingerprint: true },
    });
    for (const r of rows) found.add(r.fingerprint);
  }
  return found;
}

async function knownIbans(db: Db, orgId: string): Promise<Set<string>> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { iban: true } });
  const methods = await db.paymentMethod.findMany({
    where: { orgId, isActive: true, bankIban: { not: null } },
    select: { bankIban: true },
  });
  const out = new Set<string>();
  if (org?.iban) out.add(normalizeIban(org.iban));
  for (const m of methods) if (m.bankIban) out.add(normalizeIban(m.bankIban));
  return out;
}

export async function importBankStatement(
  orgId: string,
  bytes: Uint8Array,
  opts: BankImportOptions,
): Promise<BankImportResult> {
  rateLimit(`bank-import:${orgId}`, { limit: 10, windowMs: 60_000 });

  const xml = decodeCamtBytes(bytes);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const parsed = parseCamt(xml);

  // Fingerabdruecke je Konto ueber alle Meldungen der Datei laufend zaehlen.
  const byAccount = new Map<string, ParsedTransaction[]>();
  for (const st of parsed.statements) {
    const list = byAccount.get(st.accountIban) ?? [];
    list.push(...st.transactions);
    byAccount.set(st.accountIban, list);
  }
  const planned: PlannedTx[] = [];
  for (const [accountIban, txs] of byAccount) {
    const fps = transactionFingerprints(accountIban, txs);
    txs.forEach((tx, i) => planned.push({ accountIban, fingerprint: fps[i], tx }));
  }

  const accounts = [...byAccount.keys()];
  const firstIban = parsed.statements[0]?.accountIban ?? "";
  const first = parsed.statements[0];

  const buildResult = (
    status: "preview" | "imported",
    importId: string | null,
    importedCount: number,
    duplicateCount: number,
    known: Set<string>,
  ): BankImportResult => {
    const warnings: BankImportWarning[] = [];
    if (accounts.length > 1) warnings.push("MULTIPLE_ACCOUNTS");
    if (accounts.some((a) => !known.has(normalizeIban(a)))) warnings.push("UNKNOWN_ACCOUNT");
    if (importedCount === 0) warnings.push("NOTHING_NEW");
    return {
      status,
      importId,
      format: parsed.format,
      schemaVersion: parsed.schemaVersion,
      accountIban: firstIban ? maskIban(firstIban) : "",
      entryCount: parsed.entryCount,
      importedCount,
      duplicateCount,
      skippedCount: parsed.skippedCount,
      warnings,
    };
  };

  const existingImport = async (db: Db): Promise<{ id: string; createdAt: Date } | null> =>
    db.bankStatementImport.findUnique({
      where: { orgId_fileSha256: { orgId, fileSha256 } },
      select: { id: true, createdAt: true },
    });

  if (opts.dryRun) {
    const prior = await existingImport(dbInternal);
    if (prior) throw new BankImportDuplicateError(prior.id, prior.createdAt);
    const existing = await loadExisting(dbInternal, orgId, planned.map((p) => p.fingerprint));
    const dup = planned.filter((p) => existing.has(p.fingerprint)).length;
    return buildResult("preview", null, planned.length - dup, dup, await knownIbans(dbInternal, orgId));
  }

  try {
    return await dbInternal.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const prior = await existingImport(tx);
      if (prior) throw new BankImportDuplicateError(prior.id, prior.createdAt);

      const existing = await loadExisting(tx, orgId, planned.map((p) => p.fingerprint));
      const fresh = planned.filter((p) => !existing.has(p.fingerprint));
      if (fresh.length > MAX_STORED_TX) {
        throw new CamtFormatError("Zu viele neue Umsaetze in einer Datei.", "TOO_MANY_ENTRIES");
      }
      const duplicateCount = planned.length - fresh.length;
      const known = await knownIbans(tx, orgId);
      const result = buildResult("imported", null, fresh.length, duplicateCount, known);

      const created = await tx.bankStatementImport.create({
        data: {
          orgId,
          fileSha256,
          fileName: sanitizeFileName(opts.fileName),
          format: parsed.format,
          schemaVersion: parsed.schemaVersion,
          accountIban: firstIban ? normalizeIban(firstIban) : null,
          statementId: first?.statementId ?? null,
          seqNo: first?.seqNo ?? null,
          periodFrom: first?.periodFrom ?? null,
          periodTo: first?.periodTo ?? null,
          entryCount: result.entryCount,
          importedCount: result.importedCount,
          duplicateCount,
          skippedCount: result.skippedCount,
          warningsJson: result.warnings.length > 0 ? JSON.stringify(result.warnings) : null,
          createdBy: opts.actor,
        },
        select: { id: true },
      });

      for (const block of chunks(fresh, BLOCK)) {
        await tx.bankTransaction.createMany({
          data: block.map(({ accountIban, fingerprint, tx: t }) => ({
            orgId,
            importId: created.id,
            accountIban: normalizeIban(accountIban),
            fingerprint,
            bookingDate: t.bookingDate,
            valueDate: t.valueDate,
            amountCents: t.amountCents,
            currency: t.currency,
            direction: t.direction,
            counterpartyName: t.counterpartyName,
            counterpartyIban: t.counterpartyIban ? normalizeIban(t.counterpartyIban) : null,
            remittance: t.remittance,
            endToEndId: t.endToEndId,
            acctSvcrRef: t.acctSvcrRef,
            bankTxCode: t.bankTxCode,
            returnReason: t.returnReason,
            status: t.isReturn ? "RETURN" : "OPEN",
          })),
        });
      }

      await logActivity(tx, {
        orgId,
        entityType: "BANK_IMPORT",
        entityId: created.id,
        type: "BANK_STATEMENT_IMPORTED",
        actor: opts.actor,
        at: opts.now,
        data: {
          format: result.format,
          schemaVersion: result.schemaVersion,
          accountIban: result.accountIban,
          entryCount: result.entryCount,
          importedCount: result.importedCount,
          duplicateCount,
          skippedCount: result.skippedCount,
          fileName: sanitizeFileName(opts.fileName),
          source: opts.source,
        },
      });
      return { ...result, importId: created.id };
    }, TX_OPTIONS);
  } catch (e) {
    // Parallele Importe derselben Datei (ohne Zeilensperre, z. B. SQLite): Eindeutigkeit der Datei greift.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const prior = await existingImport(dbInternal);
      if (prior) throw new BankImportDuplicateError(prior.id, prior.createdAt);
    }
    throw e;
  }
}
