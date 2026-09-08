/**
 * Zod-Schemas fuer das Anfrageprotokoll der REST-API (Phase 12d, Task 1) — Einstellungen
 * (ApiSettings, standardmaessig AUS) und Listenfilter (GET-Query, ApiRequestLog).
 */
import { z } from "zod";

export const apiSettingsInputSchema = z.object({
  logRequests: z.boolean().default(false),
  logBodies: z.boolean().default(false),
  retentionDays: z.coerce.number().int().min(1).max(90).default(7),
  maxRows: z.coerce.number().int().min(100).max(20000).default(2000),
});
export type ApiSettingsInput = z.infer<typeof apiSettingsInputSchema>;

export const apiRequestLogFilterSchema = z.object({
  apiKeyId: z.string().min(1).optional(),
  // z.coerce.boolean() macht aus jedem nicht-leeren String true — fuer errorsOnly ist das
  // korrekt, weil die UI den Parameter nur setzt, wenn der Haken gesetzt ist.
  errorsOnly: z.coerce.boolean().default(false),
  path: z.string().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ApiRequestLogFilter = z.infer<typeof apiRequestLogFilterSchema>;
