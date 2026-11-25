/**
 * Fix-Runde 1 (Koordinator-Ruling b, Task 3, Phase 10): paginierte Listenfunktion fuer
 * die Recurring-Ressource (`GET /api/v1/Recurring`) — org-gescoped, Filter nach Status/
 * Kunde/Suche (Titel), analog den uebrigen `list*Api`-Funktionen aus Task 2
 * (src/domain/customer/list.ts u. a.).
 */
import { z } from "zod";
import { prisma, ciContains } from "@/lib/db";
import type { RecurringInvoice } from "@/generated/prisma/client";
import { selectCollectiveGroup, type CollectiveCandidate, type CollectiveKeyField } from "./collective";

export const recurringListFilterSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "ENDED"]).optional(),
  customerId: z.string().optional(),
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type RecurringListFilter = z.infer<typeof recurringListFilterSchema>;

export interface RecurringListResult {
  rows: RecurringInvoice[];
  total: number;
  limit: number;
  offset: number;
}

export async function listRecurring(orgId: string, rawFilter: unknown): Promise<RecurringListResult> {
  const filter = recurringListFilterSchema.parse(rawFilter);
  const where = {
    orgId,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.search ? { title: ciContains(filter.search) } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.recurringInvoice.count({ where }),
    prisma.recurringInvoice.findMany({ where, orderBy: { createdAt: "desc" }, skip: filter.offset, take: filter.limit }),
  ]);
  return { rows, total, limit: filter.limit, offset: filter.offset };
}

export interface RecurringInvoiceRow {
  id: string;
  number: string | null;
  status: string;
  issueDate: Date;
  deliveryDate: Date | null;
  grossTotalCents: number;
  currency: string;
}

/**
 * Rechnungen eines Abos, neueste zuerst: Einzelrechnungen (Herkunftsfeld am Beleg) und Sammelrechnungen
 * (Relation GENERATED_BY je beteiligtem Abo). Immer auf die Organisation begrenzt.
 */
export async function listRecurringInvoices(orgId: string, recurringId: string): Promise<RecurringInvoiceRow[]> {
  const rels = await prisma.documentRelation.findMany({
    where: { orgId, relationType: "GENERATED_BY", fromType: "INVOICE", toType: "RECURRING", toId: recurringId },
    select: { fromId: true },
  });
  const viaRelation = rels.map((r) => r.fromId);
  return prisma.invoice.findMany({
    where: { orgId, OR: [{ recurringInvoiceId: recurringId }, ...(viaRelation.length > 0 ? [{ id: { in: viaRelation } }] : [])] },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    select: { id: true, number: true, status: true, issueDate: true, deliveryDate: true, grossTotalCents: true, currency: true },
  });
}

export interface CollectivePartner {
  id: string;
  title: string;
  /** together: kommt am Stichtag in dieselbe Rechnung; split: abweichende Felder; overflow: Obergrenze erreicht. */
  state: "together" | "split" | "overflow";
  reasons: CollectiveKeyField[];
}

const PARTNER_SELECT = {
  id: true,
  orgId: true,
  title: true,
  customerId: true,
  status: true,
  collectiveBilling: true,
  nextRunDate: true,
  createdAt: true,
  currency: true,
  taxScheme: true,
  language: true,
  paymentTermsDays: true,
  autoFinalize: true,
  autoSend: true,
  emailTemplateId: true,
  billingTiming: true,
} as const;

/**
 * Weitere Abos desselben Kunden mit Sammelschalter und gleichem Berliner Stichtag, samt Einordnung
 * (gemeinsame Rechnung oder abweichende Felder). Leer, wenn das Abo selbst nicht aktiv ist oder keinen Sammelschalter hat.
 */
export async function listCollectivePartners(orgId: string, recurringId: string): Promise<CollectivePartner[]> {
  const trigger = await prisma.recurringInvoice.findFirst({ where: { id: recurringId, orgId }, select: PARTNER_SELECT });
  if (!trigger || !trigger.collectiveBilling || trigger.status !== "ACTIVE") return [];
  const others = await prisma.recurringInvoice.findMany({
    where: { orgId, customerId: trigger.customerId, status: "ACTIVE", collectiveBilling: true, id: { not: recurringId } },
    select: PARTNER_SELECT,
  });
  const group = selectCollectiveGroup(trigger as CollectiveCandidate, others as CollectiveCandidate[]);
  const titles = new Map(others.map((o) => [o.id, o.title]));
  const out: CollectivePartner[] = [];
  for (const id of group.members) if (id !== recurringId) out.push({ id, title: titles.get(id) ?? id, state: "together", reasons: [] });
  for (const s of group.split) out.push({ id: s.id, title: titles.get(s.id) ?? s.id, state: "split", reasons: s.reasons });
  for (const id of group.overflow) out.push({ id, title: titles.get(id) ?? id, state: "overflow", reasons: [] });
  return out;
}
