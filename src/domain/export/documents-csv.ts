/**
 * CSV-Spalten fuer Belege (Phase 18b, Task 2): Rechnungen, Angebote/AB/Proforma, Lieferscheine.
 * Die Id-Menge (Filter, Sortierung) liefert die jeweilige Liste (`listInvoiceIds` u. a.); hier
 * werden die Zeilen nur in Bloecken zu 500 Ids nachgeladen (SQLite-Parametergrenze) und in der
 * Reihenfolge der Ids ausgegeben. Jede Abfrage traegt `orgId`. Interne Notizen und interne
 * Referenzen stehen in keiner Spalte.
 */
import { prisma } from "@/lib/db";
import { chunkIds } from "@/lib/id-filter";
import { buyerSnapshotSchema } from "@/schemas";
import { effectiveInvoiceStatus, INVOICE_STATUS_LABEL } from "@/domain/invoice/status";
import { openAmountCents, payableBaseCents } from "@/domain/invoice/amounts";
import { effectiveQuoteStatus } from "@/domain/document/status";
import { tagsForDocuments } from "@/domain/tag/list";
import { taxSchemeLabel } from "@/lib/tax-scheme-label";
import type { TagDocType } from "@/schemas/tag";
import { col, csvTable, type CsvColumn } from "./csv-writer";
import { DELIVERY_NOTE_STATUS_LABEL, INVOICE_TYPE_LABEL, QUOTE_KIND_LABEL, QUOTE_STATUS_LABEL, labelOf } from "./labels";

const BLOCK = 500;

/** Kundenname aus dem Snapshot (festgeschriebene Belege), sonst Stammdaten (Entwurf/defekter Snapshot). */
function snapshotName(json: string | null, live: string): string {
  if (!json) return live;
  try {
    const parsed = buyerSnapshotSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.name : live;
  } catch {
    return live;
  }
}

async function loadInOrder<T extends { id: string }>(ids: readonly string[], loadBlock: (block: string[]) => Promise<T[]>): Promise<T[]> {
  const byId = new Map<string, T>();
  for (const block of chunkIds(ids, BLOCK)) {
    for (const row of await loadBlock(block)) byId.set(row.id, row);
  }
  const out: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

async function tagNames(orgId: string, docType: TagDocType, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const block of chunkIds(ids, BLOCK)) {
    for (const [docId, tags] of await tagsForDocuments(orgId, docType, block)) names.set(docId, tags.map((t) => t.name).join(", "));
  }
  return names;
}

export async function invoicesCsv(orgId: string, ids: readonly string[], now: Date): Promise<string> {
  const rows = await loadInOrder(ids, (block) =>
    prisma.invoice.findMany({
      where: { orgId, id: { in: block } },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        issueDate: true,
        dueDate: true,
        netTotalCents: true,
        taxTotalCents: true,
        grossTotalCents: true,
        payableCents: true,
        paidAmountCents: true,
        currency: true,
        taxScheme: true,
        subject: true,
        orderNumber: true,
        buyerSnapshotJson: true,
        customer: { select: { name: true, customerNumber: true } },
      },
    }),
  );
  const tags = await tagNames(orgId, "INVOICE", ids);
  type R = (typeof rows)[number];
  const columns: CsvColumn<R>[] = [
    col("Nummer", "text", (r) => r.number),
    col("Typ", "text", (r) => labelOf(INVOICE_TYPE_LABEL, r.type)),
    col("Status", "text", (r) => INVOICE_STATUS_LABEL[effectiveInvoiceStatus(r, now)]),
    col("Datum", "berlinDate", (r) => r.issueDate),
    col("Fällig", "date", (r) => r.dueDate),
    col("Kunde", "text", (r) => snapshotName(r.buyerSnapshotJson, r.customer.name)),
    col("Kundennummer", "text", (r) => r.customer.customerNumber),
    col("Netto", "cents", (r) => r.netTotalCents),
    col("USt", "cents", (r) => r.taxTotalCents),
    col("Brutto", "cents", (r) => r.grossTotalCents),
    col("Zahlbetrag", "cents", (r) => payableBaseCents(r)),
    col("Bezahlt", "cents", (r) => r.paidAmountCents),
    // Gutschriften und Stornobelege sind keine Forderungen; Entwuerfe und Stornierte nichts Offenes.
    col("Offen", "cents", (r) => (r.status === "DRAFT" || r.status === "CANCELLED" || r.type === "CREDIT_NOTE" ? null : openAmountCents(r))),
    col("Währung", "text", (r) => r.currency),
    col("Steuerschema", "text", (r) => taxSchemeLabel(r.taxScheme)),
    col("Betreff", "text", (r) => r.subject),
    col("Bestellnummer", "text", (r) => r.orderNumber),
    col("Tags", "text", (r) => tags.get(r.id) ?? ""),
  ];
  return csvTable(columns, rows);
}

export async function quotesCsv(orgId: string, ids: readonly string[], now: Date): Promise<string> {
  const rows = await loadInOrder(ids, (block) =>
    prisma.quote.findMany({
      where: { orgId, id: { in: block } },
      select: {
        id: true,
        number: true,
        kind: true,
        status: true,
        issueDate: true,
        validUntil: true,
        netTotalCents: true,
        taxTotalCents: true,
        grossTotalCents: true,
        currency: true,
        taxScheme: true,
        subject: true,
        buyerSnapshotJson: true,
        customer: { select: { name: true, customerNumber: true } },
      },
    }),
  );
  const tags = await tagNames(orgId, "QUOTE", ids);
  type R = (typeof rows)[number];
  const columns: CsvColumn<R>[] = [
    col("Nummer", "text", (r) => r.number),
    col("Art", "text", (r) => labelOf(QUOTE_KIND_LABEL, r.kind)),
    col("Status", "text", (r) => labelOf(QUOTE_STATUS_LABEL, effectiveQuoteStatus(r, now))),
    col("Datum", "berlinDate", (r) => r.issueDate),
    col("Gültig bis", "berlinDate", (r) => r.validUntil),
    col("Kunde", "text", (r) => snapshotName(r.buyerSnapshotJson, r.customer.name)),
    col("Kundennummer", "text", (r) => r.customer.customerNumber),
    col("Netto", "cents", (r) => r.netTotalCents),
    col("USt", "cents", (r) => r.taxTotalCents),
    col("Brutto", "cents", (r) => r.grossTotalCents),
    col("Währung", "text", (r) => r.currency),
    col("Steuerschema", "text", (r) => taxSchemeLabel(r.taxScheme)),
    col("Betreff", "text", (r) => r.subject),
    col("Tags", "text", (r) => tags.get(r.id) ?? ""),
  ];
  return csvTable(columns, rows);
}

export async function deliveryNotesCsv(orgId: string, ids: readonly string[]): Promise<string> {
  const rows = await loadInOrder(ids, (block) =>
    prisma.deliveryNote.findMany({
      where: { orgId, id: { in: block } },
      select: {
        id: true,
        number: true,
        status: true,
        issueDate: true,
        deliveryDate: true,
        shippingDate: true,
        buyerSnapshotJson: true,
        customer: { select: { name: true, customerNumber: true } },
      },
    }),
  );
  const tags = await tagNames(orgId, "DELIVERY_NOTE", ids);
  type R = (typeof rows)[number];
  const columns: CsvColumn<R>[] = [
    col("Nummer", "text", (r) => r.number),
    col("Status", "text", (r) => labelOf(DELIVERY_NOTE_STATUS_LABEL, r.status)),
    col("Datum", "berlinDate", (r) => r.issueDate),
    col("Lieferdatum", "date", (r) => r.deliveryDate),
    col("Versanddatum", "date", (r) => r.shippingDate),
    col("Kunde", "text", (r) => snapshotName(r.buyerSnapshotJson, r.customer.name)),
    col("Kundennummer", "text", (r) => r.customer.customerNumber),
    col("Tags", "text", (r) => tags.get(r.id) ?? ""),
  ];
  return csvTable(columns, rows);
}
