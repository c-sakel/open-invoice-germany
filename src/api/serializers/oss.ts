/**
 * Zod-Schemas fuer `GET /api/v1/Report/oss` (Phase 16e): Eingabe (`ossQuerySchema`, geteilt mit
 * MCP) und Ausgabe `OssThreshold` (alle Betraege Integer-Cent).
 */
import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { OssCountModeSchema } from "@/schemas/oss";

export { ossQuerySchema } from "@/schemas/oss";

const ossYearSumSchema = z.object({
  year: z.number().int(),
  netEurCents: z.number().int(),
  percent: z.number().int(),
  documentCount: z.number().int(),
  skippedWithoutEur: z.number().int(),
  byCountry: z.array(z.object({ countryCode: z.string(), netEurCents: z.number().int() })),
});

export const ossThresholdSchema = z.object({
  thresholdCents: z.number().int(),
  warnPercent: z.number().int(),
  mode: OssCountModeSchema,
  level: z.enum(["OK", "WARN", "EXCEEDED"]),
  previousYearExceeded: z.boolean(),
  current: ossYearSumSchema,
  previous: ossYearSumSchema,
  notice: z.string(),
});
