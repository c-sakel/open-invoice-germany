/**
 * /api/v1/BaseInterestRate/{id} — einzelner Basiszinssatz-Eintrag (Phase 14a, Task 4).
 * Nur `DELETE` (kein GET/PATCH je Einzeleintrag noetig — die Liste traegt bereits alle
 * Felder, eine Ratenaenderung ist ein erneutes `POST` mit demselben `validFrom`, Muster
 * `src/domain/dunning/base-rate.ts#upsertBaseRate`). `deleteBaseRate` verweigert den
 * letzten verbleibenden Eintrag der Organisation (`ValidationError`) — die Verzugszins-
 * berechnung darf nie ohne Satz dastehen. `ValidationError` ist NICHT in der globalen
 * Fehler-Registry (src/api/errors.ts, semantisch 400, kein 409-Konflikt) — dasselbe
 * Muster wie `CustomerValidationError` in src/app/api/v1/Contact/route.ts: als
 * `z.ZodError` weiterwerfen, damit `withApi` es auf 400 mappt.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { deleteBaseRate } from "@/domain/dunning/base-rate";
import { ValidationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withApi<{ id: string }>(async (_req, ctx) => {
  try {
    await deleteBaseRate(ctx.orgId, ctx.params.id);
  } catch (e) {
    if (e instanceof ValidationError) throw new z.ZodError([{ code: "custom", path: ["id"], message: e.message }]);
    throw e;
  }
  return apiData({ deleted: true });
}, { scope: "admin" });

export const spec = {
  remove: {
    path: "/api/v1/BaseInterestRate/{id}",
    method: "DELETE",
    summary: "Basiszinssatz loeschen (nicht der letzte verbleibende Eintrag)",
    scope: "admin",
    response: apiDataResponseSchema(z.object({ deleted: z.boolean() })),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
