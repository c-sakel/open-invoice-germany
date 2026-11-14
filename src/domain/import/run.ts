/**
 * CSV-Import von Kunden und Produkten (Phase 18b). Vorschau (`dryRun`) validiert mit `dbInternal`;
 * der Commit validiert vollstaendig NEU innerhalb einer Transaktion (nur `tx`, erste Anweisung
 * `lockOrganization`) und legt seriell an. Jeder Fehler wirft `ImportRejectedError` (Rollback, kein
 * Nummernkreis verbraucht): alles oder nichts. `expectedHash` bindet den Commit an die gesehene
 * Vorschau (409). Kein Update bestehender Datensaetze, keine Datei auf der Platte; `orgId` stammt nur
 * vom Aufrufer, nie aus der CSV (Spalten wie `id`/`orgId` werden ignoriert und gemeldet).
 * Rate-Limits je Organisation (UI, REST und MCP gleich): Vorschau 20/min, Commit 5/min.
 */
import { z } from "zod";
import type { Prisma, Customer } from "@/generated/prisma/client";
import type { CustomerInput } from "@/schemas";
import { dbInternal } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { lockOrganization } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { createCustomerWithinTx } from "@/domain/customer/save";
import { createProductWithinTx } from "@/domain/product/save";
import { CONTACT_IMPORT_COLUMNS, PRODUCT_IMPORT_COLUMNS, mapHeader, type ImportColumn } from "./columns";
import { CsvFormatError, CsvLimitError, MAX_IMPORT_BYTES, parseCsv, sha256Hex } from "./parse-csv";
import { takenNumbers, validateContactRows, type ValidatedRows } from "./contacts-import";
import { validateProductRows } from "./products-import";
import { clipHeaderName, sanitizeFileName, type ColumnIndex, type ImportRowError, type ParsedRow } from "./types";

export type { ImportRowError } from "./types";
export type ImportResource = "contacts" | "products";

export const MAX_LISTED_ERRORS = 200;
export const PREVIEW_SAMPLE_ROWS = 50;

export const importRequestSchema = z.object({
  csv: z.string().min(1).max(MAX_IMPORT_BYTES),
  fileName: z.string().trim().max(200).optional(),
  dryRun: z.boolean().default(true),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Gleiche Datei innerhalb von 24 h bewusst erneut importieren (Doppel-Import-Schutz aufheben). */
  allowRepeat: z.boolean().default(false),
});

export interface ImportPreview {
  resource: ImportResource;
  fileHash: string;
  encoding: "utf-8" | "windows-1252";
  delimiter: ";" | ",";
  totalRows: number;
  validRows: number;
  errorCount: number;
  errors: ImportRowError[];
  ignoredColumns: string[];
  sample?: { line: number; values: Record<string, string> }[];
}
export type ImportResult = { status: "preview"; preview: ImportPreview } | { status: "imported"; created: number; preview: ImportPreview };

export class ImportRejectedError extends Error {
  readonly status = 422;
  constructor(readonly preview: ImportPreview) {
    super("Import abgelehnt: Die Datei enthält Fehler.");
    this.name = "ImportRejectedError";
  }
}
export class ImportHashMismatchError extends Error {
  readonly status = 409;
  constructor() {
    super("Die Datei hat sich seit der Vorschau geändert.");
    this.name = "ImportHashMismatchError";
  }
}

export const IMPORT_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export class ImportAlreadyDoneError extends Error {
  readonly status = 409;
  constructor() {
    super("Datei wurde bereits importiert");
    this.name = "ImportAlreadyDoneError";
  }
}

export interface ImportContext {
  actor: string;
  source: "UI" | "API" | "MCP";
  withSample?: boolean;
  now?: Date;
}

const COLLISION_MESSAGE = "Nummer aus dem Nummernkreis bereits vergeben — Nummernkreis anpassen";

/**
 * Legt bereits validierte Kunden seriell in der Transaktion `tx` an (Aufrufer sperrt vorher die Organisation).
 * Vergibt der Nummernkreis eine bereits belegte Nummer, wird die `ref` in `collisions` gemeldet (der Aufrufer
 * verwirft dann per Rollback die gesamte Anlage).
 */
export async function createContactsWithinTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  valid: readonly { ref: number; value: CustomerInput }[],
): Promise<{ customers: Customer[]; collisions: number[] }> {
  const taken = await takenNumbers(tx, orgId, valid.map((v) => v.value));
  const customers: Customer[] = [];
  const collisions: number[] = [];
  for (const row of valid) {
    const c = await createCustomerWithinTx(tx, orgId, row.value);
    if (!row.value.customerNumber) {
      if (c.customerNumber && taken.has(c.customerNumber)) collisions.push(row.ref);
      if (c.customerNumber) taken.add(c.customerNumber);
    }
    customers.push(c);
  }
  return { customers, collisions };
}

const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

export async function runCsvImport(
  orgId: string,
  resource: ImportResource,
  input: { text: string; encoding?: "utf-8" | "windows-1252"; fileName?: string; dryRun: boolean; expectedHash?: string; allowRepeat?: boolean },
  ctx: ImportContext,
): Promise<ImportResult> {
  if (input.dryRun) rateLimit(`csv-import-preview:${orgId}`, { limit: 20, windowMs: 60_000 });
  else rateLimit(`csv-import-commit:${orgId}`, { limit: 5, windowMs: 60_000 });

  if (Buffer.byteLength(input.text, "utf8") > MAX_IMPORT_BYTES) {
    throw new CsvLimitError("Datei zu groß (höchstens 2 MB).");
  }
  const parsed = parseCsv(input.text);
  const columns: readonly ImportColumn[] = resource === "contacts" ? CONTACT_IMPORT_COLUMNS : PRODUCT_IMPORT_COLUMNS;
  const mapping = mapHeader(parsed.header, columns);
  if (mapping.duplicates.length > 0) throw new CsvFormatError(`Spalte mehrfach vorhanden: ${mapping.duplicates.join(", ")}`, 1);
  if (mapping.missing.length > 0) throw new CsvFormatError(`Pflichtspalte fehlt: ${mapping.missing.join(", ")}`, 1);
  const fileHash = sha256Hex(input.text);
  if (input.expectedHash !== undefined && input.expectedHash !== fileHash) throw new ImportHashMismatchError();

  const rows: ParsedRow[] = parsed.rows;
  const index: ColumnIndex = mapping.index;
  const validate = (db: Parameters<typeof validateContactRows>[0]): Promise<ValidatedRows<unknown>> =>
    resource === "contacts" ? validateContactRows(db, orgId, rows, index) : validateProductRows(db, orgId, rows, index);

  const preview = (errors: ImportRowError[], validCount: number): ImportPreview => {
    const out: ImportPreview = {
      resource,
      fileHash,
      encoding: input.encoding ?? "utf-8",
      delimiter: parsed.delimiter,
      totalRows: rows.length,
      validRows: validCount,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_LISTED_ERRORS),
      ignoredColumns: mapping.ignored.map(clipHeaderName),
    };
    if (ctx.withSample) {
      out.sample = rows.slice(0, PREVIEW_SAMPLE_ROWS).map((r) => {
        const values: Record<string, string> = {};
        for (const col of columns) {
          const i = index.get(col.key);
          if (i !== undefined) values[col.header] = r.cells[i] ?? "";
        }
        return { line: r.line, values };
      });
    }
    return out;
  };

  if (input.dryRun) {
    const res = await validate(dbInternal);
    return { status: "preview", preview: preview(res.errors, res.valid.length) };
  }

  const created = await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    if (input.allowRepeat !== true) {
      // Doppel-Import-Schutz: der Inhalts-Hash steht als ActivityLog (entityType IMPORT, entityId = Hash);
      // Pruefung ueber tx nach der Org-Sperre, damit parallele Commits serialisiert sind.
      const since = new Date((ctx.now ?? new Date()).getTime() - IMPORT_REPEAT_WINDOW_MS);
      const prior = await tx.activityLog.findFirst({
        where: { orgId, entityType: "IMPORT", entityId: fileHash, type: "CSV_IMPORTED", at: { gte: since } },
        select: { id: true },
      });
      if (prior) throw new ImportAlreadyDoneError();
    }
    const res = await validate(tx);
    if (res.errors.length > 0) throw new ImportRejectedError(preview(res.errors, res.valid.length));
    const collisions: ImportRowError[] = [];
    let count = 0;
    if (resource === "contacts") {
      const contacts = res.valid as { line: number; value: CustomerInput }[];
      const made = await createContactsWithinTx(tx, orgId, contacts.map((r) => ({ ref: r.line, value: r.value })));
      for (const ref of made.collisions) collisions.push({ line: ref, column: "Kundennummer", message: COLLISION_MESSAGE });
      count = made.customers.length;
    } else {
      const taken = res.taken;
      for (const row of res.valid) {
        const p = await createProductWithinTx(tx, orgId, row.value as Parameters<typeof createProductWithinTx>[2]);
        if (!(row.value as { articleNumber?: string }).articleNumber) {
          if (p.articleNumber && taken.has(p.articleNumber)) collisions.push({ line: row.line, column: "Artikelnummer", message: COLLISION_MESSAGE });
          if (p.articleNumber) taken.add(p.articleNumber);
        }
        count += 1;
      }
    }
    if (collisions.length > 0) throw new ImportRejectedError(preview(collisions, res.valid.length - collisions.length));
    // Protokoll in derselben Transaktion: Daten existieren nie ohne Audit-Eintrag.
    await logActivity(tx, {
      orgId,
      entityType: "IMPORT",
      entityId: fileHash,
      type: "CSV_IMPORTED",
      actor: ctx.actor,
      at: ctx.now,
      data: { resource, created: count, fileName: sanitizeFileName(input.fileName), fileHash, source: ctx.source },
    });
    return { count, valid: res.valid.length };
  }, TX_OPTIONS);

  const result = preview([], created.valid);
  return { status: "imported", created: created.count, preview: result };
}
