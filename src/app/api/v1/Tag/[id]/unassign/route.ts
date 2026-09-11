/**
 * POST /api/v1/Tag/{id}/unassign — entfernt die Zuordnung eines Tags von einem Beleg
 * (Phase 13d, Task 5). Ruling siehe `../assign/route.ts`: POST statt `DELETE` mit Body.
 * `untagDocument` (src/domain/tag/assign.ts) ist idempotent (`deleteMany`) — eine nicht
 * bestehende Zuordnung liefert `removed: false`, keinen Fehler.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { untagDocument } from "@/domain/tag/assign";
import { tagAssignSchema } from "@/schemas/tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  // untagDocument wirft bei einem unbekannten Tag bereits NotFoundError direkt — anders
  // als tagDocument gibt es hier keinen zweiten Fehlerpfad (kein assertDocExists: eine
  // nicht bestehende Zuordnung ist idempotent `removed: false`, kein 404 noetig, der
  // Beleg selbst muss dafuer nicht mehr existieren).
  const result = await untagDocument(ctx.orgId, ctx.params.id, ctx.body, ctx.actor);
  return apiData(result);
}, { scope: "write" });

export const spec = {
  // Bewusst NICHT "create" (siehe ../assign/route.ts) — Handler antwortet 200.
  unassign: {
    path: "/api/v1/Tag/{id}/unassign",
    method: "POST",
    summary: "Tag-Zuordnung von einem Beleg entfernen (idempotent)",
    scope: "write",
    request: { body: tagAssignSchema },
    response: apiDataResponseSchema(z.object({ removed: z.boolean() })),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
