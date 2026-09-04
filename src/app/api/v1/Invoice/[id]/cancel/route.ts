/**
 * POST /api/v1/Invoice/{id}/cancel — Rechnung stornieren (GoBD-konforme Storno-Gutschrift,
 * Original bleibt erhalten). Task 3, task-3-facts.md: ruft exakt `cancelInvoice`.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.invoice.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Rechnung nicht gefunden.");
  const result = await cancelInvoice(ctx.params.id, { actor: ctx.actor });
  return apiData({
    originalNumber: result.originalNumber,
    creditNoteId: result.creditNote.id,
    creditNoteNumber: result.creditNote.number,
  });
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Invoice/{id}/cancel",
    method: "POST",
    summary: "Rechnung stornieren (Storno-Gutschrift)",
    scope: "write",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
