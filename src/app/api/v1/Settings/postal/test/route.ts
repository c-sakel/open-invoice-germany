/**
 * POST /api/v1/Settings/postal/test — Verbindungstest (Phase 16d). Scope admin.
 * Fragt ausschliesslich das Guthaben ab, versendet nichts. Antwort ohne Zugangsdaten.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { testPostalConnection } from "@/domain/postal/connection";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) => {
  checkPostalRateLimit(ctx.orgId);
  return apiData(await testPostalConnection(ctx.orgId));
}, { scope: "admin" });

const testResultSchema = z.object({ ok: z.boolean(), balanceCents: z.number().int().optional(), error: z.string().optional() });

export const spec = {
  test: {
    path: "/api/v1/Settings/postal/test",
    method: "POST",
    summary: "Verbindung zum Briefdienst pruefen (nur Guthabenabfrage, kein Versand)",
    scope: "admin",
    response: apiDataResponseSchema(testResultSchema),
    errors: [401, 403, 409, 429, 502],
  },
} satisfies Record<string, RouteSpec>;
