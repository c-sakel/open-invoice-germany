/**
 * Zod-Schemas fuer `GET /api/v1/Report/smallBusiness`: Eingabe (`kuQuerySchema`, geteilt mit MCP)
 * und Ausgabe `KuThreshold` (alle Betraege Integer-Cent).
 */
import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";

export { kuQuerySchema } from "@/schemas/small-business";

const kuYearSumSchema = z.object({
  year: z.number().int(),
  receivedCents: z.number().int(),
  invoicedCents: z.number().int(),
  externalCents: z.number().int(),
  totalReceivedCents: z.number().int(),
  totalInvoicedCents: z.number().int(),
  documentCount: z.number().int(),
  skippedWithoutEur: z.number().int(),
});

export const kuThresholdSchema = z.object({
  applies: z.boolean(),
  year: z.number().int(),
  warnPercent: z.number().int(),
  startYear: z.number().int().nullable(),
  currentLimitCents: z.number().int(),
  previousYearLimitCents: z.number().int(),
  level: z.enum(["OK", "WARN", "NEXT_YEAR_LOST", "EXCEEDED"]),
  reasons: z.array(
    z.enum(["APPROACHING_LIMIT", "APPROACHING_NEXT_YEAR_LIMIT", "INVOICED_OVER_LIMIT", "CURRENT_OVER_25000", "CURRENT_OVER_LIMIT", "PREVIOUS_OVER_25000"]),
  ),
  current: kuYearSumSchema,
  previous: kuYearSumSchema,
  notice: z.string(),
});
