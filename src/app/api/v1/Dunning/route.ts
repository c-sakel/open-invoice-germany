/**
 * /api/v1/Dunning — Mahnungen. Kein PATCH (append-only Beleg). `createDunning` prueft
 * NICHT, dass invoiceId zur aufrufenden Organisation gehoert (siehe
 * src/app/api/invoices/[id]/dunning/route.ts — dieselbe vorbestehende Luecke) — Route
 * prueft daher vorab.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeDunning } from "@/api/serializers/dunning";
import { listDunningsApi, dunningListFilterSchema } from "@/domain/dunning/list";
import { createDunning } from "@/domain/dunning/create";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createBodySchema = z.object({
  invoiceId: z.string().min(1),
  force: z.boolean().optional(),
  lateFeeCents: z.number().int().min(0).optional(),
});

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const result = await listDunningsApi(ctx.orgId, Object.fromEntries(searchParams));
  return apiList(result.rows.map(serializeDunning), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const { invoiceId, ...rest } = createBodySchema.parse(ctx.body);
  const owned = await dbInternal.invoice.findFirst({ where: { id: invoiceId, orgId: ctx.orgId }, select: { id: true } });
  if (!owned) throw new NotFoundError("Rechnung nicht gefunden.");
  const res = await createDunning(invoiceId, { actor: ctx.actor, force: rest.force, lateFeeCents: rest.lateFeeCents, createdBy: "api" });
  return apiData(serializeDunning(res.dunning), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Dunning",
    method: "GET",
    summary: "Mahnungen auflisten (optional nach invoiceId)",
    scope: "read",
    request: { query: dunningListFilterSchema },
    response: apiListResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/Dunning",
    method: "POST",
    summary: "Naechste Mahnstufe erstellen",
    scope: "write",
    request: { body: createBodySchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
