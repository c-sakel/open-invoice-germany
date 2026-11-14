/** Zod-Schemas der Verbrauchserfassung (Phase 18f). */
import { z } from "zod";

export type UsageSource = "UI" | "API" | "MCP";

export const MAX_USAGE_QUANTITY_MILLI = 2_147_483_647;

export const recordUsageSchema = z.object({
  recurringLineId: z.string().trim().min(1).max(64),
  quantityMilli: z.number().int().min(1).max(MAX_USAGE_QUANTITY_MILLI),
  usageDate: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[\x21-\x7e]+$/, "Nur sichtbare ASCII-Zeichen ohne Leerzeichen")
    .optional(),
});
export type RecordUsageInput = z.infer<typeof recordUsageSchema>;

export const voidUsageSchema = z.object({
  reason: z.string().trim().min(1, "Bitte einen Grund angeben.").max(500),
});

export const listUsageQuerySchema = z.object({
  status: z.enum(["open", "billed", "voided", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
