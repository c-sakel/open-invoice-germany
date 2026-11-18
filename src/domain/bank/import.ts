/**
 * Kontoauszug-Import (CAMT.052/.053/.054) mit Vorschau. Schutz vor Doppelimport ueber den Datei-Hash
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
import { parseCamt, type ParsedCamt, type ParsedTransaction } from "./camt-parse";
import { transactionFingerprints } from "./fingerprint";
import { CamtFormatError, MAX_STORED_TX } from "./errors";

export const MAX_IMPORT_DOCUMENTS = 400;

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

export class BankImportConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("Der Import kollidiert mit einem parallelen Import. Bitte erneut versuchen.");
    this.name = "BankImportConflictError";
  }
}

export type BankImportWarning = "UNKNOWN_ACCOUNT" | "MULTIPLE_ACCOUNTS" | "NOTHING_NEW" | "NON_EUR" | "RETURNS";

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
  /** Verworfene Umsaetze je Grund. */
  skippedReasons: Record<string, number>;
  /** Rueckbuchungen/Rueckgaben in der Datei (nur zur Pruefung, nie buchbar). */
  returnCount: number;
  warnings: BankImportWarning[];
  /** Vorschau einer bereits importierten Datei. */
  duplicateOf?: { importId: string; importedAt: Date };
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

export interface BankDocumentsImportOptions {
  actor: string;
  source: "FINTS";
  now?: Date;
  expectedIban: string;
}

interface ImportMeta {
  origin: "UPLOAD" | "FINTS";
  fileName?: string;
  source: "UI" | "API" | "MCP" | "FINTS";
  actor: string;
  now?: Date;
  dryRun?: boolean;
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
  return importParsed(orgId, [parsed], fileSha256, {
    origin: "UPLOAD",
    fileName: opts.fileName,
    source: opts.source,
    actor: opts.actor,
    now: opts.now,
    dryRun: opts.dryRun,
  });
}

/**
 * Mehrere abgerufene CAMT-Dokumente eines Kontos als EIN Import: Umsaetze in Dokumentreihenfolge
 * zusammenfuehren, Fingerabdruecke einmal ueber die ganze Folge bilden.
 */
export async function importBankDocuments(
  orgId: string,
  docs: readonly Uint8Array[],
  opts: BankDocumentsImportOptions,
): Promise<BankImportResult> {
  if (docs.length > MAX_IMPORT_DOCUMENTS) {
    throw new CamtFormatError("Zu viele Dokumente in einem Abruf.", "TOO_MANY_DOCUMENTS");
  }
  if (docs.length === 0) {
    return {
      status: "imported",
      importId: null,
      format: "",
      schemaVersion: "",
      accountIban: maskIban(opts.expectedIban),
      entryCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      skippedCount: 0,
      skippedReasons: {},
      returnCount: 0,
      warnings: ["NOTHING_NEW"],
    };
  }
  const expected = normalizeIban(opts.expectedIban);
  const parsedList: ParsedCamt[] = [];
  const hashes: string[] = [];
  for (const bytes of docs) {
    const parsed = parseCamt(decodeCamtBytes(bytes));
    for (const st of parsed.statements) {
      if (normalizeIban(st.accountIban) !== expected) {
        throw new CamtFormatError("Ein Dokument gehoert nicht zum abgerufenen Konto.", "ACCOUNT_MISMATCH");
      }
    }
    parsedList.push(parsed);
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  const fileSha256 = createHash("sha256")
    .update("fints\n" + hashes.map((h) => `${h}\n`).join(""))
    .digest("hex");
  let from: Date | null = null;
  let to: Date | null = null;
  for (const p of parsedList) {
    for (const st of p.statements) {
      if (st.periodFrom && (!from || st.periodFrom < from)) from = st.periodFrom;
      if (st.periodTo && (!to || st.periodTo > to)) to = st.periodTo;
    }
  }
  const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "unbekannt");
  return importParsed(orgId, parsedList, fileSha256, {
    origin: "FINTS",
    fileName: `kontoabruf-${maskIban(expected).replace(/\s+/g, "")}-${day(from)}-${day(to)}.xml`,
    source: opts.source,
    actor: opts.actor,
    now: opts.now,
  });
}

async function importParsed(
  orgId: string,
  parsedList: readonly ParsedCamt[],
  fileSha256: string,
  opts: ImportMeta,
): Promise<BankImportResult> {
  const firstDoc = parsedList[0]!;
  const parsed = {
    format: firstDoc.format,
    schemaVersion: firstDoc.schemaVersion,
    statements: parsedList.flatMap((p) => p.statements),
    entryCount: parsedList.reduce((n, p) => n + p.entryCount, 0),
    skippedCount: parsedList.reduce((n, p) => n + p.skippedCount, 0),
    skippedReasons: parsedList.reduce<Record<string, number>>((acc, p) => {
      for (const [k, v] of Object.entries(p.skippedReasons)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
  };

  // Fingerabdruecke je Konto ueber alle Meldungen laufend zaehlen.
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
  let periodFrom = first?.periodFrom ?? null;
  let periodTo = first?.periodTo ?? null;
  if (opts.origin === "FINTS") {
    for (const st of parsed.statements) {
      if (st.periodFrom && (!periodFrom || st.periodFrom < periodFrom)) periodFrom = st.periodFrom;
      if (st.periodTo && (!periodTo || st.periodTo > periodTo)) periodTo = st.periodTo;
    }
  }

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
    if (planned.some((p) => p.tx.currency !== "EUR")) warnings.push("NON_EUR");
    if (planned.some((p) => p.tx.isReturn)) warnings.push("RETURNS");
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
      skippedReasons: parsed.skippedReasons,
      returnCount: planned.filter((p) => p.tx.isReturn).length,
      warnings,
    };
  };

  const existingImport = async (db: Db): Promise<{ id: string; createdAt: Date } | null> =>
    db.bankStatementImport.findUnique({
      where: { orgId_fileSha256: { orgId, fileSha256 } },
      select: { id: true, createdAt: true },
    });

  if (opts.dryRun) {
    const known = await knownIbans(dbInternal, orgId);
    const prior = await existingImport(dbInternal);
    if (prior) {
      return { ...buildResult("preview", null, 0, planned.length, known), duplicateOf: { importId: prior.id, importedAt: prior.createdAt } };
    }
    const existing = await loadExisting(dbInternal, orgId, planned.map((p) => p.fingerprint));
    const dup = planned.filter((p) => existing.has(p.fingerprint)).length;
    if (planned.length - dup > MAX_STORED_TX) {
      throw new CamtFormatError("Zu viele neue Umsaetze in einer Datei.", "TOO_MANY_ENTRIES");
    }
    return buildResult("preview", null, planned.length - dup, dup, known);
  }

  const run = (): Promise<BankImportResult> =>
    dbInternal.$transaction(async (tx) => {
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
          periodFrom: periodFrom ?? null,
          periodTo: periodTo ?? null,
          origin: opts.origin,
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

  // Parallele Importe (ohne Zeilensperre, z. B. SQLite): Eindeutigkeit der Datei bzw. des Umsatzes greift.
  // Dieselbe Datei -> Duplikat; ueberlappende Datei -> einmal neu, dann sind die Umsaetze Duplikate.
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
      const prior = await existingImport(dbInternal);
      if (prior) throw new BankImportDuplicateError(prior.id, prior.createdAt);
      if (attempt >= 1) throw new BankImportConflictError();
    }
  }
}
