/**
 * Serialisierer fuer Recurring (=RecurringInvoice, Fix-Runde 1, Koordinator-Ruling b,
 * Task 3, Phase 10). Kein Beleg (kein GoBD-Bezug) — dennoch nie `notes` unreflektiert
 * als "intern" behandeln: `notes` ist hier das oeffentliche Notizfeld des Abos (analog
 * Contact.notes), es gibt kein separates `internalNotes` auf diesem Modell.
 */
import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { iso } from "./common";
import type { RecurringInvoice, RecurringInvoiceLine } from "@/generated/prisma/client";
import { z } from "zod";

export function serializeRecurringLine(l: RecurringInvoiceLine) {
  return {
    position: l.position,
    lineType: l.lineType,
    productId: l.productId,
    description: l.description,
    descriptionLong: l.descriptionLong,
    articleNumber: l.articleNumber,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    taxRate: l.taxRate,
    taxCategory: l.taxCategory,
    discountPermille: l.discountPermille,
    discountCents: l.discountCents,
    ossCategory: l.ossCategory,
  };
}

export function serializeRecurring(r: RecurringInvoice & { lines?: RecurringInvoiceLine[] }) {
  return {
    objectName: "Recurring" as const,
    id: r.id,
    customerId: r.customerId,
    title: r.title,
    status: r.status,
    interval: r.interval,
    intervalCount: r.intervalCount,
    anchorDay: r.anchorDay,
    startDate: iso(r.startDate),
    nextRunDate: r.status === "ENDED" ? null : iso(r.nextRunDate),
    endDate: iso(r.endDate),
    maxRuns: r.maxRuns,
    taxScheme: r.taxScheme,
    currency: r.currency,
    language: r.language,
    paymentTermsDays: r.paymentTermsDays,
    notes: r.notes,
    autoFinalize: r.autoFinalize,
    autoSend: r.autoSend,
    emailTemplateId: r.emailTemplateId,
    showPeriodText: r.showPeriodText,
    lastRunAt: iso(r.lastRunAt),
    issuedCount: r.issuedCount,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    // Positionen nur, wenn sie mitgeladen wurden (Einzelabruf, Aenderung).
    ...(r.lines ? { lines: [...r.lines].sort((a, b) => a.position - b.position).map(serializeRecurringLine) } : {}),
  };
}


const recurringLineSchema = z.object({
  position: z.number().int(),
  lineType: z.string().describe("ITEM | HEADING | TEXT | SUBTOTAL"),
  productId: z.string().nullable(),
  description: z.string(),
  descriptionLong: z.string().nullable(),
  articleNumber: z.string().nullable(),
  quantityMilli: z.number().int(),
  unit: z.string(),
  unitNetPriceCents: z.number().int(),
  taxRate: z.number(),
  taxCategory: z.string(),
  discountPermille: z.number().int(),
  discountCents: z.number().int(),
  ossCategory: z.string().nullable(),
});

/** OpenAPI-Response-Schema (Phase 10, Task 4) — aus serializeRecurring abgeleitet. */
export const recurringSchema = z.object({
  objectName: z.literal("Recurring"),
  id: z.string(),
  customerId: z.string(),
  title: z.string(),
  status: z.string(),
  interval: z.string(),
  intervalCount: z.number().int(),
  anchorDay: z.number().int().nullable(),
  startDate: z.string().nullable(),
  nextRunDate: z.string().nullable(),
  endDate: z.string().nullable(),
  maxRuns: z.number().int().nullable(),
  taxScheme: z.string(),
  currency: z.string(),
  language: z.string().describe("Belegsprache (de | en)."),
  paymentTermsDays: z.number().int(),
  notes: z.string().nullable(),
  autoFinalize: z.boolean(),
  autoSend: z.boolean(),
  emailTemplateId: z.string().nullable(),
  showPeriodText: z.boolean(),
  lastRunAt: z.string().nullable(),
  issuedCount: z.number().int(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  lines: z.array(recurringLineSchema).optional().describe("Positionen (nur im Einzelabruf und nach Aenderung)."),
});
