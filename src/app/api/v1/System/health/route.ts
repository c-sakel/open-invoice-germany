/**
 * GET /api/v1/System/health — Systemstatus (Phase 16a, Task 8), nur Scope `admin`.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { getSystemHealth } from "@/domain/system/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(await getSystemHealth(ctx.orgId)), { scope: "admin" });

const systemHealthSchema = z.object({
  db: z.boolean(),
  scheduler: z.record(z.string(), z.string().nullable()).describe("Je Job: Zeitpunkt des letzten erfolgreichen Laufs (ISO 8601) oder null."),
  archive: z.object({ freeBytes: z.number().int().nullable(), pending: z.number().int() }),
  chain: z.object({ lastCheckedAt: z.string(), valid: z.boolean() }).nullable(),
  backup: z.object({ lastOkAt: z.string() }).nullable(),
});

export const spec = {
  get: {
    path: "/api/v1/System/health",
    method: "GET",
    summary: "Systemstatus: Datenbank, Scheduler, Belegarchiv, Kettenpruefung, Sicherung",
    scope: "admin",
    response: apiDataResponseSchema(systemHealthSchema),
    errors: [401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
