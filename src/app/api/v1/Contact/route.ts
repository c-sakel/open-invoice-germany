/**
 * /api/v1/Contact — Kunden (=Contact, Registry task-2-facts.md). Anlegen/Aendern nutzt
 * src/domain/customer/save.ts (createCustomer/updateCustomer) — dieselbe Domain-Funktion
 * wie die Server-Action `saveCustomer` (src/app/actions/masterdata.ts) und die MCP-Tools
 * `upsert_customer`/`update_customer` (src/mcp/tools/customers.ts). Fix-Runde 1
 * (Koordinator-Ruling a, 2026-09-04): ersetzt die zuvor hier dublizierte Anlagelogik.
 */
import { z } from "zod";
import { csvListResponse } from "@/api/csv-list";
import { csvFormatQuery } from "@/domain/export";
import { withApi } from "@/api/auth";
import { queryObject } from "@/api/query";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeContact } from "@/api/serializers/contact";
import { listContactsApi, contactListFilterSchema } from "@/domain/customer/list";
import { createCustomer, CustomerValidationError } from "@/domain/customer/save";
import { customerSchema } from "@/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const csv = await csvListResponse(ctx.orgId, "contacts", searchParams);
  if (csv) return csv;
  const result = await listContactsApi(ctx.orgId, queryObject(searchParams, ["includeArchived"]));
  return apiList(result.rows.map(serializeContact), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  try {
    const created = await createCustomer(ctx.orgId, ctx.body);
    return apiData(serializeContact(created), 201);
  } catch (e) {
    // CustomerValidationError (defaultPaymentMethodId gehoert nicht zur Organisation) ist
    // NICHT in der globalen Registry (src/api/errors.ts) — sie ist domain-spezifisch fuer
    // Contact/Product und semantisch eine 400-Validierung, kein 409-Konflikt.
    if (e instanceof CustomerValidationError) throw new z.ZodError([{ code: "custom", path: [e.path ?? "defaultPaymentMethodId"], message: e.message }]);
    throw e;
  }
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Contact",
    method: "GET",
    summary: "Kunden auflisten (Paginierung/Suche); Abgleich: updatedSince + cursor; format=csv liefert text/csv (max. 20.000 Zeilen)",
    scope: "read",
    request: { query: contactListFilterSchema.extend(csvFormatQuery) },
    response: apiListResponseSchema(z.unknown(), { sync: true }),
    errors: [400, 401, 403, 413, 429],
    alternateContent: { "text/csv": { description: "Bei format=csv: CSV (UTF-8 mit BOM, Semikolon, CRLF), gleiche Filter wie die Liste ohne Paginierung, max. 20.000 Zeilen" } },
  },
  create: {
    path: "/api/v1/Contact",
    method: "POST",
    summary: "Kunden anlegen",
    scope: "write",
    request: { body: customerSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
