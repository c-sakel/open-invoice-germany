import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeProduct } from "@/api/serializers/product";
import { productSchema } from "@/schemas";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const row = await dbInternal.product.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId } });
  if (!row) throw new NotFoundError("Produkt nicht gefunden.");
  return apiData(serializeProduct(row));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  const existing = await dbInternal.product.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId } });
  if (!existing) throw new NotFoundError("Produkt nicht gefunden.");
  const v = productSchema.partial().parse(ctx.body);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(ctx.body as object)) {
    if (key in v) patch[key] = (v as Record<string, unknown>)[key];
  }
  const updated = await dbInternal.product.update({ where: { id: existing.id }, data: patch });
  return apiData(serializeProduct(updated));
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Product/{id}",
    method: "GET",
    summary: "Produkt abrufen",
    scope: "read",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/Product/{id}",
    method: "PATCH",
    summary: "Produkt aktualisieren",
    scope: "write",
    request: { body: productSchema.partial() },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
