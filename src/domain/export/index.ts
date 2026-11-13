/**
 * CSV-Export (Phase 18b, Task 2): Einstiegspunkte fuer REST/MCP (`exportFromApiFilter`, Rohfilter wie
 * die JSON-Listen) und die Oberflaeche (`exportFromPageQuery`, Seiten-Query der Listen). Die Id-Mengen
 * kommen aus den bestehenden Listenbausteinen (gleiche Filter, gleiche Sortierung); mehr als
 * `EXPORT_ROW_LIMIT` Zeilen -> `ExportTooLargeError`, bevor eine Zeile geladen wird.
 * Rate-Limit je Organisation: `csv-export:<orgId>` 30/min.
 */
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { berlinDateKey } from "@/lib/berlin-time";
import { listInvoiceIds } from "@/domain/invoice/list";
import { listQuoteIds, listDeliveryNoteIds } from "@/domain/document/list";
import { listIdsFromPageQuery, type NeighborKind } from "@/domain/document/neighbors";
import { contactsCsv, productsCsv } from "./masterdata-csv";
import { deliveryNotesCsv, invoicesCsv, quotesCsv } from "./documents-csv";
import { ExportTooLargeError } from "./errors";
import { EXPORT_ROW_LIMIT } from "./limits";

export { ExportTooLargeError };

export type ExportResource = "invoices" | "quotes" | "order-confirmations" | "documents" | "delivery-notes" | "contacts" | "products";

/** Query-Feld `format` der REST-Listen (`?format=csv`). */
export const csvFormatQuery = { format: z.enum(["json", "csv"]).optional() };

const FILE_BASE: Record<ExportResource, string> = {
  invoices: "rechnungen",
  quotes: "angebote",
  "order-confirmations": "auftragsbestaetigungen",
  documents: "dokumente",
  "delivery-notes": "lieferscheine",
  contacts: "kunden",
  products: "produkte",
};

export function exportFilename(resource: ExportResource, now: Date): string {
  return `${FILE_BASE[resource]}-${berlinDateKey(now)}.csv`;
}

function rateLimitExport(orgId: string): void {
  rateLimit(`csv-export:${orgId}`, { limit: 30, windowMs: 60_000 });
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function assertWithinLimit(ids: readonly string[], limit: number, hint?: string): void {
  if (ids.length > limit) throw new ExportTooLargeError(limit, hint);
}

async function documentCsv(orgId: string, resource: "invoices" | "quotes" | "order-confirmations" | "documents" | "delivery-notes", ids: string[], now: Date, limit: number, hint?: string): Promise<string> {
  assertWithinLimit(ids, limit, hint);
  if (resource === "invoices") return invoicesCsv(orgId, ids, now);
  if (resource === "delivery-notes") return deliveryNotesCsv(orgId, ids);
  return quotesCsv(orgId, ids, now);
}

/** REST/MCP: Rohfilter wie die JSON-Listen (ZodError -> 400); quotes/order-confirmations erzwingen `kind`. */
export async function exportFromApiFilter(
  orgId: string,
  resource: ExportResource,
  rawFilter: unknown,
  opts: { now?: Date; limit?: number; hint?: string } = {},
): Promise<{ csv: string; filename: string; rows: number }> {
  rateLimitExport(orgId);
  const now = opts.now ?? new Date();
  const filename = exportFilename(resource, now);
  const raw = asRecord(rawFilter);
  const limit = opts.limit ?? EXPORT_ROW_LIMIT;
  const take = limit + 1;

  if (resource === "contacts") return { ...(await contactsCsv(orgId, raw, { limit, hint: opts.hint })), filename };
  if (resource === "products") return { ...(await productsCsv(orgId, raw, { limit, hint: opts.hint })), filename };

  let ids: string[];
  if (resource === "invoices") ids = await listInvoiceIds(orgId, raw, { limit: take, now });
  else if (resource === "delivery-notes") ids = await listDeliveryNoteIds(orgId, raw, { limit: take });
  else {
    const kind = resource === "quotes" ? "ANGEBOT" : resource === "order-confirmations" ? "AUFTRAGSBESTAETIGUNG" : undefined;
    ids = await listQuoteIds(orgId, kind ? { ...raw, kind } : raw, { limit: take, now });
  }
  return { csv: await documentCsv(orgId, resource, ids, now, limit, opts.hint), filename, rows: ids.length };
}

/** Oberflaeche: Seiten-Query wie die Listenseiten (Kundenname-Combo, archiviert=1, billed/partially-billed). */
export async function exportFromPageQuery(
  orgId: string,
  resource: "invoices" | "documents" | "delivery-notes" | "contacts" | "products",
  params: URLSearchParams,
  opts: { now?: Date } = {},
): Promise<{ csv: string; filename: string; rows: number }> {
  rateLimitExport(orgId);
  const now = opts.now ?? new Date();
  const filename = exportFilename(resource, now);

  if (resource === "contacts" || resource === "products") {
    const q = params.get("q");
    const filter: Record<string, unknown> = q ? { search: q } : {};
    if (params.get("archiviert") === "1") filter.includeArchived = true;
    if (resource === "contacts") return { ...(await contactsCsv(orgId, filter)), filename };
    return { ...(await productsCsv(orgId, filter)), filename };
  }

  const kind: NeighborKind = resource === "invoices" ? "INVOICE" : resource === "documents" ? "QUOTE" : "DELIVERY_NOTE";
  const ids = await listIdsFromPageQuery(kind, orgId, params, { limit: EXPORT_ROW_LIMIT + 1, invalid: "throw", now });
  return { csv: await documentCsv(orgId, resource, ids, now, EXPORT_ROW_LIMIT), filename, rows: ids.length };
}
