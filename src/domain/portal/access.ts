/**
 * Lesezugriffe fuer REST und MCP: Kundenpruefung je Organisation und Abrufprotokoll eines Kunden
 * (ohne IP und User-Agent; solche Daten werden nicht erhoben).
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export async function assertPortalCustomer(orgId: string, customerId: string): Promise<void> {
  const c = await dbInternal.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true } });
  if (!c) throw new NotFoundError("Kunde nicht gefunden.");
}

export interface PortalEventRow {
  id: string;
  at: Date;
  kind: string;
  docType: string | null;
  docId: string | null;
  fileKind: string | null;
}

export async function listPortalEvents(
  orgId: string,
  customerId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<{ items: PortalEventRow[]; nextCursor: string | null }> {
  await assertPortalCustomer(orgId, customerId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.cursor) {
    // Cursor muss zu diesem Kunden dieser Organisation gehoeren (sonst Validierungsfehler statt 500).
    const anchor = await dbInternal.customerPortalEvent.findFirst({ where: { id: opts.cursor, orgId, link: { customerId, orgId } }, select: { id: true } });
    if (!anchor) throw new z.ZodError([{ code: "custom", path: ["cursor"], message: "Ungültiger Cursor." }]);
  }
  const rows = await dbInternal.customerPortalEvent.findMany({
    where: { orgId, link: { customerId, orgId } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, at: true, kind: true, docType: true, docId: true, fileKind: true },
  });
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

export async function countPortalEvents(orgId: string, customerId: string): Promise<number> {
  return dbInternal.customerPortalEvent.count({ where: { orgId, link: { customerId, orgId } } });
}
