/**
 * POST /api/v1/PostalJob/{id}/resolve — manueller Abschluss eines Auftrags mit unklarem Ausgang (Status UNKNOWN).
 * Der Betreiber hat beim Briefdienst geprueft: outcome SENT (-> DONE) oder NOT_SENT (-> FAILED, erneuter Versand moeglich).
 * Scope write; begruendende Notiz Pflicht; Eintrag im Protokoll und ChangeLog.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";
import { resolveUnknownPostalJob } from "@/domain/postal/resolve";
import { postalResolveInputSchema } from "@/schemas/postal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const input = postalResolveInputSchema.parse(ctx.body);
  checkPostalRateLimit(ctx.orgId);
  return apiData(await resolveUnknownPostalJob(ctx.orgId, ctx.params.id, input.outcome, input.note, { actor: ctx.actor }));
}, { scope: "write" });

export const spec = {
  resolve: {
    path: "/api/v1/PostalJob/{id}/resolve",
    method: "POST",
    summary: "Auftrag mit unklarem Ausgang manuell abschliessen (SENT oder NOT_SENT, mit Begruendung)",
    scope: "write",
    request: { body: postalResolveInputSchema },
    response: apiDataResponseSchema(z.object({ status: z.enum(["DONE", "FAILED"]) })),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
