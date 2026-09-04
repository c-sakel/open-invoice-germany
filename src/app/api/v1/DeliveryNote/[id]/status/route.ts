/**
 * POST /api/v1/DeliveryNote/{id}/status — MARK_CREATED/MARK_SENT/MARK_DELIVERED/CANCEL/
 * ARCHIVE/UNARCHIVE. Task 3, task-3-facts.md: ruft exakt `setDeliveryNoteStatus`/
 * `setArchived` (dieselben Domain-Funktionen wie das MCP-Tool `set_document_status` und
 * die Session-Route `/api/documents/[id]/status` fuer DELIVERY_NOTE).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { setDeliveryNoteStatus, setArchived } from "@/domain/document/status";
import { documentStatusActionSchema } from "@/schemas";
import { prisma } from "@/lib/db";
import { NotFoundError, InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_TARGET = { MARK_CREATED: "CREATED", MARK_SENT: "SENT", MARK_DELIVERED: "DELIVERED", CANCEL: "CANCELLED" } as const;

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.deliveryNote.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Lieferschein nicht gefunden.");
  const input = documentStatusActionSchema.parse(ctx.body);

  if (input.action === "ARCHIVE" || input.action === "UNARCHIVE") {
    await setArchived(ctx.orgId, "DELIVERY_NOTE", existing.id, input.action === "ARCHIVE", ctx.actor);
    return apiData({ id: existing.id, archived: input.action === "ARCHIVE" });
  }
  if (input.action === "MARK_ACCEPTED" || input.action === "MARK_REJECTED") {
    throw new InvalidOperationError(`${input.action} ist fuer DeliveryNote nicht gueltig.`);
  }
  const target = ACTION_TARGET[input.action];
  const updated = await setDeliveryNoteStatus(ctx.orgId, existing.id, target, { actor: ctx.actor, note: input.note });
  return apiData({ id: updated.id, status: updated.status, number: updated.number });
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/DeliveryNote/{id}/status",
    method: "POST",
    summary: "Lieferscheinstatus setzen",
    scope: "write",
    request: { body: documentStatusActionSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
