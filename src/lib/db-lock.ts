import type { Prisma } from "@/generated/prisma/client";
import { isPostgresUrl } from "@/lib/db";

export type LockableTable = "Quote" | "Invoice" | "DeliveryNote";

const ALLOWED = new Set<LockableTable>(["Quote", "Invoice", "DeliveryNote"]);

/**
 * Zeilensperre (`SELECT ... FOR UPDATE`) auf die Quellzeile einer Transaktion.
 * Unter Postgres serialisiert sie parallele Ableitungen/Fortschreibungen
 * derselben Quelle; unter SQLite No-op, da SQLite Schreibtransaktionen ohnehin
 * serialisiert. Der Tabellenname stammt nur aus der festen Whitelist, die `id`
 * wird immer als Parameter gebunden. Als ERSTE Anweisung der Transaktion
 * aufrufen (vor jedem Lesen).
 */
export async function lockRow(tx: Prisma.TransactionClient, table: LockableTable, id: string): Promise<void> {
  if (!ALLOWED.has(table)) throw new Error(`lockRow: Tabelle nicht erlaubt: ${String(table)}`);
  if (!isPostgresUrl(process.env.DATABASE_URL)) return;
  await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);
}

/** Sperrt mehrere Zeilen dedupliziert und nach table+id sortiert (kein Deadlock). */
export async function lockRows(tx: Prisma.TransactionClient, rows: { table: LockableTable; id: string }[]): Promise<void> {
  const seen = new Map<string, { table: LockableTable; id: string }>();
  for (const r of rows) seen.set(`${r.table}\u0000${r.id}`, r);
  const sorted = [...seen.values()].sort((a, b) =>
    a.table === b.table ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.table < b.table ? -1 : 1,
  );
  for (const r of sorted) await lockRow(tx, r.table, r.id);
}
