/**
 * POST /api/v1/Invoice/{id}/credit — Teilgutschrift zu einer festgeschriebenen Rechnung
 * (Original bleibt erhalten; fuer einen Vollstorno: /cancel). Task 3, task-3-facts.md:
 * ruft exakt `createPartialCreditNote` mit demselben Zod-Schema wie die Session-Route
 * (`partialCreditSchema`, src/schemas).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { partialCreditSchema } from "@/schemas";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.invoice.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Rechnung nicht gefunden.");
  const input = partialCreditSchema.parse(ctx.body);
  const res = await createPartialCreditNote(ctx.params.id, input, { actor: ctx.actor });
  return apiData({ creditNoteId: res.creditNote.id, creditNoteNumber: res.creditNote.number, originalNumber: res.originalNumber }, 201);
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Invoice/{id}/credit",
    method: "POST",
    summary: "Teilgutschrift zu einer Rechnung anlegen",
    scope: "write",
    request: { body: partialCreditSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
