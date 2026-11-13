/**
 * GET one und PATCH (Phase 17b): PATCH bearbeitet nur Entwuerfe (DRAFT), sonst 409.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeDeliveryNote } from "@/api/serializers/delivery-note";
import { parseEmbed } from "@/api/serializers/common";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { updateDraftDeliveryNote } from "@/domain/delivery-note/update";
import { updateDeliveryNoteSchema } from "@/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const embed = parseEmbed(searchParams);
  const row = await prisma.deliveryNote.findFirst({
    where: { id: ctx.params.id, orgId: ctx.orgId },
    include: { lines: embed.has("lines"), customer: embed.has("customer") },
  });
  if (!row) throw new NotFoundError("Lieferschein nicht gefunden.");
  return apiData(serializeDeliveryNote(row, embed));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.deliveryNote.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Lieferschein nicht gefunden.");
  const input = updateDeliveryNoteSchema.parse(ctx.body);
  await updateDraftDeliveryNote(ctx.orgId, existing.id, input, { actor: ctx.actor });
  const full = await prisma.deliveryNote.findUniqueOrThrow({ where: { id: existing.id }, include: { lines: true } });
  return apiData(serializeDeliveryNote(full, new Set(["lines"])));
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/DeliveryNote/{id}",
    method: "GET",
    summary: "Lieferschein abrufen",
    scope: "read",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/DeliveryNote/{id}",
    method: "PATCH",
    summary: "Lieferschein-Entwurf aktualisieren (nur Status DRAFT)",
    scope: "write",
    request: { body: updateDeliveryNoteSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
