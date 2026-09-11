/**
 * POST /api/v1/Tag/{id}/assign — ordnet einen Tag einem Beleg zu (Phase 13d, Task 5).
 * Ruling task-5-brief.md: Zuordnen/Entfernen laeuft ueber eigene POST-Aktionsrouten
 * (`assign`/`unassign`) statt eines `DELETE` MIT Body — `withApi` parst einen Body nur
 * bei POST/PATCH/PUT (src/api/auth.ts#BODY_METHODS), `DELETE /api/v1/Tag/{id}` bleibt
 * dem bodylosen Loeschen des Tags selbst vorbehalten (siehe `../route.ts`).
 * `tagDocument` (src/domain/tag/assign.ts) ist idempotent — ein bereits zugeordneter
 * Tag liefert `created: false`, keinen Fehler.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { tagDocument } from "@/domain/tag/assign";
import { tagAssignSchema } from "@/schemas/tag";
import { RelationError } from "@/domain/relations";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  try {
    const result = await tagDocument(ctx.orgId, ctx.params.id, ctx.body, ctx.actor);
    return apiData(result);
  } catch (e) {
    // RelationError ist NICHT im Registry-Fallback (src/api/errors.ts) — Beleg nicht
    // gefunden/fremde Organisation ist hier ein 404 (Muster src/app/api/v1/Attachment/
    // route.ts). `tagDocument` selbst wirft bei einem unbekannten Tag bereits
    // `NotFoundError` direkt, keine Uebersetzung noetig.
    if (e instanceof RelationError) throw new NotFoundError(e.message);
    throw e;
  }
}, { scope: "write" });

export const spec = {
  // Bewusst NICHT "create" (der `successStatus`-Formel in src/api/openapi.ts wuerde
  // sonst 201 dokumentieren) — der Handler antwortet mit dem `apiData`-Default 200,
  // die Zuordnung ist idempotent, kein neues Ressourcen-Objekt.
  assign: {
    path: "/api/v1/Tag/{id}/assign",
    method: "POST",
    summary: "Tag einem Beleg zuordnen (idempotent)",
    scope: "write",
    request: { body: tagAssignSchema },
    response: apiDataResponseSchema(z.object({ created: z.boolean() })),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
