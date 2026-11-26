/**
 * Phase 10, Task 2 (task-2-facts.md): kleine Listenfunktion fuer die Contact-Ressource
 * (=Customer) — org-gescoped, Paginierung/Filter fuer die API (`GET /api/v1/Contact`).
 * `search` sucht ueber Name/Kundennummer/E-Mail (analog dem bisherigen Kundenlisten-UI).
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { customerListPageSchema } from "@/schemas/customer-list";
import { prisma, ciContains } from "@/lib/db";
import { nextSyncCursor, resolveSyncWindow, syncFilterShape, syncWhere, SYNC_ORDER_BY } from "@/domain/sync/updated-since";
import type { Customer } from "@/generated/prisma/client";

export const contactListFilterSchema = z.object({
  search: z.string().max(100).optional(),
  includeArchived: z.boolean().optional(),
  ...syncFilterShape,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ContactListFilter = z.infer<typeof contactListFilterSchema>;

export interface ContactListResult {
  rows: Customer[];
  total: number;
  limit: number;
  offset: number;
  /** Nur im Abgleich (updatedSince): Cursor der Folgeseite, null = letzte Seite. */
  nextCursor?: string | null;
}

export async function listContactsApi(orgId: string, rawFilter: unknown): Promise<ContactListResult> {
  const filter = contactListFilterSchema.parse(rawFilter);
  const sync = resolveSyncWindow(rawFilter, filter);
  const where = {
    orgId,
    ...(filter.includeArchived ? {} : { isArchived: false }),
    ...(filter.search
      ? {
          OR: [{ name: ciContains(filter.search) }, { customerNumber: ciContains(filter.search) }, { email: ciContains(filter.search) }],
        }
      : {}),
  };
  const windowWhere = sync ? { AND: [where, syncWhere({ since: sync.since, after: null })] } : where;
  const pageWhere = sync && sync.after ? { AND: [where, syncWhere(sync)] } : windowWhere;
  const [total, rows] = await Promise.all([
    prisma.customer.count({ where: windowWhere }),
    prisma.customer.findMany(
      sync
        ? { where: pageWhere, orderBy: [...SYNC_ORDER_BY], take: filter.limit }
        : { where, orderBy: { createdAt: "desc" }, skip: filter.offset, take: filter.limit },
    ),
  ]);
  return { rows, total, limit: filter.limit, offset: filter.offset, ...(sync ? { nextCursor: nextSyncCursor(rows, filter.limit) } : {}) };
}

/**
 * Fix-Welle M2: loest den Rohwert des "combo"-Kundenfilters der vier Listenseiten
 * (`FilterBar`, Feld `customerId`) serverseitig auf — mit UND ohne JavaScript kommt
 * hier derselbe Rohtext an (eine `customerId` aus einem Link/Lesezeichen ODER ein per
 * `<datalist>` getippter Kundenname), `FilterBar` bildet ihn seit dieser Fix-Welle nicht
 * mehr selbst ab. Bei exaktem Treffer (Id ODER Name) ersetzt der Aufrufer `customerId`
 * im Rohfilter durch die aufgeloeste Id; ohne Treffer faellt der Rohtext auf die
 * Volltextsuche `q` zurueck (Spec-Zusage „freier Text faellt auf `q` zurueck"), sofern
 * dort noch kein eigener Suchbegriff steht — mutiert `rawFilter` in-place, analog dem
 * bestehenden `withoutStatus`-Muster der Listenseiten.
 */
export async function applyCustomerComboFilter(orgId: string, rawFilter: Record<string, unknown>): Promise<void> {
  const raw = rawFilter.customerId;
  if (typeof raw !== "string" || !raw) return;
  const match = await prisma.customer.findFirst({ where: { orgId, OR: [{ id: raw }, { name: raw }] }, select: { id: true } });
  if (match) {
    rawFilter.customerId = match.id;
    return;
  }
  delete rawFilter.customerId;
  if (!rawFilter.q) rawFilter.q = raw;
}

/**
 * Der nach `applyCustomerComboFilter` gewaehlte Kunde (Id + Name) fuer die Filterleiste —
 * eine Einzelabfrage statt einer Kundenliste. Nur Kunden der Organisation.
 */
export async function loadComboCustomer(orgId: string, rawFilter: Record<string, unknown>): Promise<{ id: string; label: string } | undefined> {
  const id = rawFilter.customerId;
  if (typeof id !== "string" || !id) return undefined;
  const row = await prisma.customer.findFirst({ where: { orgId, id }, select: { id: true, name: true } });
  return row ? { id: row.id, label: row.name } : undefined;
}

export const CUSTOMER_LIST_PAGE_SIZE = 50;

/** Where-Bedingung der Kundenliste (rein): Org-Scope, Archiv, Suche ohne Groß-/Kleinschreibung. */
export function customerListWhere(orgId: string, q: string | undefined, archived: boolean): Prisma.CustomerWhereInput {
  const term = q?.trim();
  return {
    orgId,
    ...(archived ? {} : { isArchived: false }),
    ...(term
      ? {
          OR: [
            { name: ciContains(term) },
            { customerNumber: ciContains(term) },
            { email: ciContains(term) },
            { city: ciContains(term) },
            { vatId: ciContains(term) },
          ],
        }
      : {}),
  };
}

/** Eine Seite der Kundenliste (50 Zeilen), sortiert nach Name. */
export async function listCustomersPage(orgId: string, raw: unknown) {
  const input = customerListPageSchema.parse(raw);
  const where = customerListWhere(orgId, input.q, input.archiviert === "1");
  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: input.offset,
      take: CUSTOMER_LIST_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        city: true,
        type: true,
        vatId: true,
        customerNumber: true,
        isArchived: true,
        contacts: { where: { isDefault: true }, select: { firstName: true, lastName: true }, take: 1 },
      },
    }),
  ]);
  return { rows, total, limit: CUSTOMER_LIST_PAGE_SIZE, offset: input.offset, q: input.q ?? "" };
}
