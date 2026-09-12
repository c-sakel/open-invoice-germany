/**
 * Serialisierer fuer `/api/v1/BaseInterestRate` (Phase 14a, Task 4, R6 — Basiszinssatz-
 * Halbjahrestabelle, § 288 Abs. 1 Satz 2 BGB). Nimmt die Prisma-Zeile aus
 * `src/domain/dunning/base-rate.ts#listBaseRates`/`upsertBaseRate` entgegen.
 * `validFrom` als reines Datum (`YYYY-MM-DD`, wie beim Eingabeschema
 * `baseInterestRateInputSchema`) — anders als `createdAt`/`updatedAt`, die echte
 * Zeitstempel sind (`iso`, volle ISO-8601-Datetime).
 */
import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { iso } from "./common";

export interface BaseInterestRateRow {
  id: string;
  validFrom: Date;
  rateBp: number;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeBaseInterestRate(r: BaseInterestRateRow) {
  return {
    objectName: "BaseInterestRate" as const,
    id: r.id,
    validFrom: r.validFrom.toISOString().slice(0, 10),
    rateBp: r.rateBp,
    source: r.source,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

/** OpenAPI-Response-Schema (Phase 14a, Task 4) — aus serializeBaseInterestRate abgeleitet. */
export const baseInterestRateSchema = z.object({
  objectName: z.literal("BaseInterestRate"),
  id: z.string(),
  validFrom: z.string(),
  rateBp: z.number().int(),
  source: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
