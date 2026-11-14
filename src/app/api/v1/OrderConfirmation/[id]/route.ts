import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeQuote } from "@/api/serializers/document";
import { parseEmbed } from "@/api/serializers/common";
import { updateDraftDocument } from "@/domain/document/update";
import { updateDocumentSchema } from "@/schemas";
import { apiDocumentUpdateBodyDocSchema, grossResponseFields, resolvePriceInput } from "@/domain/document/price-input";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const embed = parseEmbed(searchParams);
  const row = await prisma.quote.findFirst({
    where: { id: ctx.params.id, orgId: ctx.orgId, kind: "AUFTRAGSBESTAETIGUNG" },
    include: { lines: embed.has("lines"), customer: embed.has("customer") },
  });
  if (!row) throw new NotFoundError("Auftragsbestätigung nicht gefunden.");
  return apiData(serializeQuote(row, "OrderConfirmation", embed));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await prisma.quote.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId, kind: "AUFTRAGSBESTAETIGUNG" }, select: { id: true } });
  if (!existing) throw new NotFoundError("Auftragsbestätigung nicht gefunden.");
  const priced = resolvePriceInput(ctx.body);
  const input = updateDocumentSchema.parse(priced.body);
  await updateDraftDocument(ctx.orgId, ctx.params.id, input, ctx.actor);
  const full = await prisma.quote.findUniqueOrThrow({ where: { id: ctx.params.id } });
  return apiData({ ...serializeQuote(full, "OrderConfirmation", new Set()), ...grossResponseFields(priced, full.grossTotalCents) });
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/OrderConfirmation/{id}",
    method: "GET",
    summary: "Auftragsbestätigung abrufen",
    scope: "read",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/OrderConfirmation/{id}",
    method: "PATCH",
    summary: "Auftragsbestätigung aktualisieren (nur Entwurf)",
    scope: "write",
    request: { body: apiDocumentUpdateBodyDocSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
    errorNotes: { 400: "Bruttopreise: bei Abweichung ueber 1 Cent je Steuersatz error.code GROSS_DEVIATION (Validierungsfehler 400)." },
  },
} satisfies Record<string, RouteSpec>;
