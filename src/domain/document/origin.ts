/**
 * Herkunft fuer eine ganze Listenseite (Phase 13a, Task 2); zwei Quellen in dieser
 * Reihenfolge: die denormalisierten Felder am Beleg (`Invoice.sourceType/sourceId`,
 * `Invoice.recurringInvoiceId`, `DeliveryNote.sourceType/sourceId`) und — nur fuer
 * Belege ohne solche — die `CONVERTED_TO`-Relation. Feste Abfragezahl (2 + max. 4
 * Quellabfragen), kein zweiter Relationsbegriff neben src/domain/relations.ts (RefType
 * dort deckt Quote/Invoice/DeliveryNote/Recurring bereits ab).
 */
import { prisma } from "@/lib/db";
import { DOC_TYPE_LABEL } from "@/lib/email/doc-type-labels";
import { DocRefType } from "@/schemas";
import type { z } from "zod";

export type OriginKind = Extract<z.infer<typeof DocRefType>, "INVOICE" | "DELIVERY_NOTE">;
type SourceType = Extract<z.infer<typeof DocRefType>, "QUOTE" | "INVOICE" | "DELIVERY_NOTE" | "RECURRING">;

export interface OriginRef {
  href: string;
  label: string;
}

interface SourceRef {
  type: SourceType;
  id: string;
}

function hrefFor(type: SourceType, id: string): string {
  switch (type) {
    case "QUOTE":
      return `/dokumente/${id}`;
    case "INVOICE":
      return `/rechnungen/${id}`;
    case "DELIVERY_NOTE":
      return `/lieferscheine/${id}`;
    case "RECURRING":
      return `/abos/${id}`;
  }
}

function labelFor(type: SourceType, row: { kind?: string | null; number?: string | null; title?: string | null }): string {
  switch (type) {
    case "QUOTE": {
      const kindLabel = DOC_TYPE_LABEL[(row.kind ?? "ANGEBOT") as keyof typeof DOC_TYPE_LABEL] ?? row.kind ?? "Angebot";
      return `aus ${kindLabel} ${row.number ?? "(Entwurf)"}`;
    }
    case "INVOICE":
      return `aus Rechnung ${row.number ?? "(Entwurf)"}`;
    case "DELIVERY_NOTE":
      return `aus Lieferschein ${row.number ?? "(Entwurf)"}`;
    case "RECURRING":
      return `aus Abo ${row.title ?? ""}`;
  }
}

/**
 * Liefert je Beleg-Id (aus `ids`) die Herkunft — falls vorhanden. Fehlende Eintraege in
 * der Rueckgabe-Map bedeuten "kein Herkunftsbeleg" (z. B. manuell angelegt).
 */
export async function originsFor(orgId: string, kind: OriginKind, ids: readonly string[]): Promise<Map<string, OriginRef>> {
  const out = new Map<string, OriginRef>();
  if (ids.length === 0) return out;
  const idList = [...ids];

  interface SourceRow {
    id: string;
    sourceType: string | null;
    sourceId: string | null;
    recurringInvoiceId?: string | null;
  }
  const rows: SourceRow[] =
    kind === "INVOICE"
      ? await prisma.invoice.findMany({
          where: { orgId, id: { in: idList } },
          select: { id: true, sourceType: true, sourceId: true, recurringInvoiceId: true },
        })
      : await prisma.deliveryNote.findMany({
          where: { orgId, id: { in: idList } },
          select: { id: true, sourceType: true, sourceId: true },
        });

  const source = new Map<string, SourceRef>();
  for (const r of rows) {
    if (r.sourceType && r.sourceId) source.set(r.id, { type: r.sourceType as SourceType, id: r.sourceId });
    else if (r.recurringInvoiceId) source.set(r.id, { type: "RECURRING", id: r.recurringInvoiceId });
  }

  // Belege ohne denormalisierte Quelle: CONVERTED_TO zeigt VON der Quelle AUF den Beleg
  // (src/domain/document/convert.ts) — eine Abfrage fuer alle fehlenden Ids.
  const missing = idList.filter((id) => !source.has(id));
  if (missing.length > 0) {
    const rels = await prisma.documentRelation.findMany({
      where: { orgId, relationType: "CONVERTED_TO", toType: kind, toId: { in: missing } },
      select: { fromType: true, fromId: true, toId: true },
      orderBy: { createdAt: "asc" },
    });
    for (const rel of rels) if (!source.has(rel.toId)) source.set(rel.toId, { type: rel.fromType as SourceType, id: rel.fromId });
  }

  if (source.size === 0) return out;

  // Je Quelltyp gesammelte Ids, fuer genau eine Nummernabfrage je Typ (max. 4, nur bei
  // anfallenden Ids) statt einer Abfrage je Zeile.
  const idsByType: Record<SourceType, string[]> = { QUOTE: [], INVOICE: [], DELIVERY_NOTE: [], RECURRING: [] };
  for (const ref of source.values()) idsByType[ref.type].push(ref.id);

  const [quotes, invoices, deliveryNotes, recurring] = await Promise.all([
    idsByType.QUOTE.length > 0
      ? prisma.quote.findMany({ where: { orgId, id: { in: idsByType.QUOTE } }, select: { id: true, kind: true, number: true } })
      : Promise.resolve([]),
    idsByType.INVOICE.length > 0
      ? prisma.invoice.findMany({ where: { orgId, id: { in: idsByType.INVOICE } }, select: { id: true, number: true } })
      : Promise.resolve([]),
    idsByType.DELIVERY_NOTE.length > 0
      ? prisma.deliveryNote.findMany({ where: { orgId, id: { in: idsByType.DELIVERY_NOTE } }, select: { id: true, number: true } })
      : Promise.resolve([]),
    idsByType.RECURRING.length > 0
      ? prisma.recurringInvoice.findMany({ where: { orgId, id: { in: idsByType.RECURRING } }, select: { id: true, title: true } })
      : Promise.resolve([]),
  ]);

  const rowById = new Map<string, { kind?: string | null; number?: string | null; title?: string | null }>();
  for (const q of quotes) rowById.set(`QUOTE:${q.id}`, q);
  for (const i of invoices) rowById.set(`INVOICE:${i.id}`, i);
  for (const dn of deliveryNotes) rowById.set(`DELIVERY_NOTE:${dn.id}`, dn);
  for (const r of recurring) rowById.set(`RECURRING:${r.id}`, r);

  for (const [docId, ref] of source) {
    const row = rowById.get(`${ref.type}:${ref.id}`);
    if (!row) continue;
    out.set(docId, { href: hrefFor(ref.type, ref.id), label: labelFor(ref.type, row) });
  }
  return out;
}
