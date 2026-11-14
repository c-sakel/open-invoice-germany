import { z } from "zod";
import { csvListResponse } from "@/api/csv-list";
import { csvFormatQuery } from "@/domain/export";
import { withApi } from "@/api/auth";
import { queryObject } from "@/api/query";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeProduct } from "@/api/serializers/product";
import { listProductsApi, productListFilterSchema } from "@/domain/product/list";
import { createProduct } from "@/domain/product/save";
import { productSchema } from "@/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const csv = await csvListResponse(ctx.orgId, "products", searchParams);
  if (csv) return csv;
  const result = await listProductsApi(ctx.orgId, queryObject(searchParams, ["includeArchived"]));
  return apiList(result.rows.map(serializeProduct), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const created = await createProduct(ctx.orgId, ctx.body);
  return apiData(serializeProduct(created), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Product",
    method: "GET",
    summary: "Produkte auflisten; Abgleich: updatedSince + cursor; format=csv liefert text/csv (max. 20.000 Zeilen)",
    scope: "read",
    request: { query: productListFilterSchema.extend(csvFormatQuery) },
    response: apiListResponseSchema(z.unknown(), { sync: true }),
    errors: [400, 401, 403, 413, 429],
    alternateContent: { "text/csv": { description: "Bei format=csv: CSV (UTF-8 mit BOM, Semikolon, CRLF), gleiche Filter wie die Liste ohne Paginierung, max. 20.000 Zeilen" } },
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
