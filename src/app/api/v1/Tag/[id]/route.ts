/**
 * /api/v1/Tag/{id} — einzelner Tag (Phase 13d, Task 5, Muster
 * src/app/api/v1/TextTemplate/[id]/route.ts). `DELETE` ist bodylos (kein Zuordnungsziel
 * hier — Zuordnen/Entfernen laeuft ueber POST `/assign`/`/unassign`, siehe deren eigene
 * Routen) und entfernt den Tag samt aller seiner Zuordnungen per DB-Cascade
 * (src/domain/tag/manage.ts#deleteTag) — GoBD-unbedenklich, ruehrt keinen Beleg an.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeTag, tagSchema } from "@/api/serializers/tag";
import { getTagRow } from "@/domain/tag/list";
import { saveTag, deleteTag, TagNotFoundError, TagNameConflictError } from "@/domain/tag/manage";
import { tagInputSchema } from "@/schemas/tag";
import { NotFoundError, InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const row = await getTagRow(ctx.orgId, ctx.params.id);
  if (!row) throw new NotFoundError("Tag nicht gefunden.");
  return apiData(serializeTag(row));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  try {
    await saveTag(ctx.orgId, ctx.params.id, ctx.body);
  } catch (e) {
    if (e instanceof TagNotFoundError) throw new NotFoundError("Tag nicht gefunden.");
    if (e instanceof TagNameConflictError) throw new InvalidOperationError(e.message);
    throw e;
  }
  // saveTag liefert die rohe Prisma-Zeile ohne `documentCount` — ein erneuter Zugriff
  // ueber getTagRow liefert dieselbe Form wie GET/List (Zuordnungszahl kann sich seit
  // dem letzten Lesen geaendert haben, z. B. durch einen parallelen assign/unassign).
  const row = await getTagRow(ctx.orgId, ctx.params.id);
  if (!row) throw new NotFoundError("Tag nicht gefunden.");
  return apiData(serializeTag(row));
}, { scope: "write" });

export const DELETE = withApi<{ id: string }>(async (_req, ctx) => {
  try {
    await deleteTag(ctx.orgId, ctx.params.id, ctx.actor);
  } catch (e) {
    if (e instanceof TagNotFoundError) throw new NotFoundError("Tag nicht gefunden.");
    throw e;
  }
  return apiData({ deleted: true });
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Tag/{id}",
    method: "GET",
    summary: "Tag abrufen",
    scope: "read",
    response: apiDataResponseSchema(tagSchema),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/Tag/{id}",
    method: "PATCH",
    summary: "Tag aktualisieren (Name/Farbe)",
    scope: "write",
    request: { body: tagInputSchema },
    response: apiDataResponseSchema(tagSchema),
    errors: [400, 401, 403, 404, 409, 429],
  },
  remove: {
    path: "/api/v1/Tag/{id}",
    method: "DELETE",
    summary: "Tag loeschen (entfernt alle seine Zuordnungen)",
    scope: "write",
    response: apiDataResponseSchema(z.object({ deleted: z.boolean() })),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
