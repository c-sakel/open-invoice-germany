import type { Prisma } from "@/generated/prisma/client";
import { isPostgresUrl } from "@/lib/db";

export type LockableTable = "Customer" | "Quote" | "Invoice" | "DeliveryNote" | "PostalSettings" | "RecurringInvoice";

const ALLOWED = new Set<LockableTable>(["Customer", "Quote", "Invoice", "DeliveryNote", "PostalSettings", "RecurringInvoice"]);

/**
 * Zeilensperre (`SELECT ... FOR UPDATE`) auf die Quellzeile einer Transaktion.
 * Unter Postgres serialisiert sie parallele Ableitungen/Fortschreibungen
 * derselben Quelle; unter SQLite No-op, da SQLite Schreibtransaktionen ohnehin
 * serialisiert. Der Tabellenname stammt nur aus der festen Whitelist, `id` und `orgId`
 * werden immer als Parameter gebunden; der Org-Scope verhindert, dass eine fremde ID die Zeile
 * einer anderen Organisation sperrt. Als ERSTE Anweisung der Transaktion
 * aufrufen (vor jedem Lesen).
 */
export async function lockRow(tx: Prisma.TransactionClient, table: LockableTable, id: string, orgId: string): Promise<void> {
  if (!ALLOWED.has(table)) throw new Error(`lockRow: Tabelle nicht erlaubt: ${String(table)}`);
  if (!isPostgresUrl(process.env.DATABASE_URL)) return;
  await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = $1 AND "orgId" = $2 FOR UPDATE`, id, orgId);
}

/** Sperrt mehrere Zeilen einer Organisation dedupliziert und nach table+id sortiert (kein Deadlock). */
export async function lockRows(tx: Prisma.TransactionClient, orgId: string, rows: { table: LockableTable; id: string }[]): Promise<void> {
  const seen = new Map<string, { table: LockableTable; id: string }>();
  for (const r of rows) seen.set(`${r.table}\u0000${r.id}`, r);
  const sorted = [...seen.values()].sort((a, b) =>
    a.table === b.table ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.table < b.table ? -1 : 1,
  );
  for (const r of sorted) await lockRow(tx, r.table, r.id, orgId);
}

/**
 * Sperrt die Organisationszeile (`FOR NO KEY UPDATE`) und serialisiert damit Schreibpfade, die ueber
 * viele Zeilen hinweg auf Eindeutigkeit pruefen (CSV-Import). `NO KEY UPDATE` blockiert keine
 * Fremdschluesselpruefungen anderer Schreibpfade. Unter SQLite No-op. Als ERSTE Anweisung der
 * Transaktion aufrufen; `orgId` wird immer als Parameter gebunden.
 */
export async function lockOrganization(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  if (!isPostgresUrl(process.env.DATABASE_URL)) return;
  await tx.$queryRawUnsafe(`SELECT 1 FROM "Organization" WHERE "id" = $1 FOR NO KEY UPDATE`, orgId);
}
