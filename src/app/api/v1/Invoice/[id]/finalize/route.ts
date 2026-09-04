/**
 * POST /api/v1/Invoice/{id}/finalize — Rechnung festschreiben (Phase 10, Task 3,
 * task-3-facts.md: ruft exakt `finalizeInvoice`, dieselbe Domain-Funktion wie UI/MCP).
 * `finalizeInvoice` kennt keinen eigenen orgId-Guard (Signatur `(invoiceId, opts)`) —
 * die Route prueft die Organisationszugehoerigkeit deshalb selbst vorab (Muster aus
 * Task 2, `/api/v1/Invoice/{id}` PATCH).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.invoice.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Rechnung nicht gefunden.");
  const invoice = await finalizeInvoice(ctx.params.id, { actor: ctx.actor });
  return apiData({ id: invoice.id, number: invoice.number, status: invoice.status });
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Invoice/{id}/finalize",
    method: "POST",
    summary: "Rechnung festschreiben (Rechnungsnummer, GoBD-unveraenderbar)",
    scope: "write",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
