/**
 * POST /api/v1/Invoice/{id}/payment — Zahlung erfassen. Task 3, task-3-facts.md: ruft
 * exakt `recordPayment` (dasselbe Zod-Schema `recordPaymentSchema` wie UI/MCP/
 * `/api/v1/Payment`). `recordPayment` prueft die Organisationszugehoerigkeit bereits
 * selbst ueber `opts.orgId` (Task-2-Fix-Runde 1, Ruling b) — kein eigener Vorab-Check
 * noetig, analog `/api/v1/Payment` (POST).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { recordPayment } from "@/domain/invoice/payment";
import { recordPaymentSchema } from "@/schemas";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const input = recordPaymentSchema.parse(ctx.body);
  const result = await recordPayment(ctx.params.id, input, { actor: ctx.actor, orgId: ctx.orgId });
  const created = await prisma.payment.findFirstOrThrow({ where: { invoiceId: ctx.params.id }, orderBy: { createdAt: "desc" } });
  return apiData(
    {
      id: created.id,
      status: result.payment.status,
      paidAmountCents: result.payment.paidAmountCents,
      skontoSuggestion: result.skontoSuggestion ?? null,
      skontoApplied: !!result.skontoPayment,
    },
    201,
  );
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Invoice/{id}/payment",
    method: "POST",
    summary: "Zahlung auf eine Rechnung erfassen",
    scope: "write",
    request: { body: recordPaymentSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
