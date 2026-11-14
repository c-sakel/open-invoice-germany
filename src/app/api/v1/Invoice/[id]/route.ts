import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeInvoice } from "@/api/serializers/invoice";
import { parseEmbed } from "@/api/serializers/common";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { updateInvoiceSchema } from "@/schemas";
import { prisma } from "@/lib/db";
import { apiInvoiceUpdateBodyDocSchema, grossResponseFields, resolvePriceInput } from "@/domain/document/price-input";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const embed = parseEmbed(searchParams);
  const row = await prisma.invoice.findFirst({
    where: { id: ctx.params.id, orgId: ctx.orgId },
    include: { lines: embed.has("lines"), customer: embed.has("customer"), payments: embed.has("payments") },
  });
  if (!row) throw new NotFoundError("Rechnung nicht gefunden.");
  return apiData(serializeInvoice(row, embed));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.invoice.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Rechnung nicht gefunden.");
  const priced = resolvePriceInput(ctx.body);
  const input = updateInvoiceSchema.parse(priced.body);
  await updateDraftInvoice(ctx.orgId, ctx.params.id, input, ctx.actor);
  const full = await prisma.invoice.findUniqueOrThrow({ where: { id: ctx.params.id } });
  return apiData({ ...serializeInvoice(full, new Set()), ...grossResponseFields(priced, full.grossTotalCents) });
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Invoice/{id}",
    method: "GET",
    summary: "Rechnung abrufen",
    scope: "read",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/Invoice/{id}",
    method: "PATCH",
    summary: "Rechnung aktualisieren (nur Entwurf)",
    scope: "write",
    request: { body: apiInvoiceUpdateBodyDocSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
    errorNotes: { 400: "Bruttopreise: bei Abweichung ueber 1 Cent je Steuersatz error.code GROSS_DEVIATION (Validierungsfehler 400)." },
  },
} satisfies Record<string, RouteSpec>;
