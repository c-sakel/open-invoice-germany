/**
 * Serialisierer der Verbrauchssaetze (Phase 18f, Task 7). Gibt nur Felder des Satzes selbst
 * aus — kein `createdBy`, keine Interna anderer Abos.
 */
import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf stehen
import { z } from "zod";
import { iso } from "./common";
import type { UsageView } from "@/domain/recurring/usage";

export function serializeUsage(u: UsageView) {
  return {
    objectName: "RecurringUsage" as const,
    id: u.id,
    recurringLineId: u.recurringLineId,
    usageDate: iso(u.usageDate),
    periodStart: iso(u.periodStart),
    periodEnd: iso(u.periodEnd),
    quantityMilli: u.quantityMilli,
    note: u.note,
    source: u.source,
    externalId: u.externalId,
    status: u.status,
    invoiceId: u.invoiceId,
    invoiceNumber: u.invoiceNumber,
    voidReason: u.voidReason,
    createdAt: iso(u.createdAt),
  };
}

export const usageSchema = z.object({
  objectName: z.literal("RecurringUsage"),
  id: z.string(),
  recurringLineId: z.string().nullable(),
  usageDate: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  quantityMilli: z.number().int().describe("Menge in tausendstel Einheiten (2,5 = 2500)."),
  note: z.string().nullable(),
  source: z.string().describe("UI | API | MCP"),
  externalId: z.string().nullable(),
  status: z.enum(["open", "billed", "voided"]),
  invoiceId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export function serializeOpenUsage(o: { recurringLineId: string; quantityMilli: number; periodEnd: Date }) {
  return { recurringLineId: o.recurringLineId, quantityMilli: o.quantityMilli, periodEnd: iso(o.periodEnd) };
}

export const openUsageSchema = z.object({
  recurringLineId: z.string(),
  quantityMilli: z.number().int(),
  periodEnd: z.string().nullable(),
});

export const usageListResponseSchema = z.object({
  data: z.array(usageSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int().describe("Immer 0; weiter per nextCursor."),
  nextCursor: z.string().nullable(),
  meta: z.object({ open: z.array(openUsageSchema).describe("Offene (noch nicht abgerechnete) Menge je Position.") }),
});

export const usageRecordResponseSchema = z.object({
  data: usageSchema,
  replayed: z.literal(true).optional().describe("Nur bei Wiederholung mit gleicher externalId (Antwort dann 200 statt 201)."),
});
