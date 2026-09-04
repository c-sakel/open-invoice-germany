import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeProduct } from "@/api/serializers/product";
import { listProductsApi, productListFilterSchema } from "@/domain/product/list";
import { productSchema } from "@/schemas";
import { dbInternal } from "@/lib/db";
import { assignArticleNumber } from "@/domain/numbering/ranges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const result = await listProductsApi(ctx.orgId, Object.fromEntries(searchParams));
  return apiList(result.rows.map(serializeProduct), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const v = productSchema.parse(ctx.body);
  const data = {
    name: v.name,
    description: v.description ?? null,
    articleNumber: v.articleNumber ?? null,
    unit: v.unit,
    netPriceCents: v.netPriceCents,
    taxRate: v.taxRate,
    taxCategory: v.taxCategory,
    differential: v.differential,
  };
  const created = await dbInternal.$transaction(async (tx) => {
    const articleNumber = data.articleNumber ?? (await assignArticleNumber(tx, ctx.orgId));
    return tx.product.create({ data: { ...data, articleNumber, orgId: ctx.orgId } });
  });
  return apiData(serializeProduct(created), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Product",
    method: "GET",
    summary: "Produkte auflisten",
    scope: "read",
    request: { query: productListFilterSchema },
    response: apiListResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/Product",
    method: "POST",
    summary: "Produkt anlegen",
    scope: "write",
    request: { body: productSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
