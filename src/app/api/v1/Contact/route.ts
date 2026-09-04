/**
 * /api/v1/Contact — Kunden (=Contact, Registry task-2-facts.md). Anlegen/Aendern folgt
 * demselben Muster wie die Server-Action `saveCustomer` (src/app/actions/masterdata.ts)
 * und das MCP-Tool `upsert_customer`/`update_customer` (src/mcp/tools/customers.ts):
 * `customerSchema` + `assignCustomerNumber` bei fehlender Nummer. Es existiert (Stand
 * Task 2) KEINE gemeinsame Domain-Funktion fuer Customer-Anlage/-Aenderung — die Route
 * dupliziert bewusst NICHTS Neues (identisches Muster wie Action/MCP), siehe
 * task-2-report.md "Deviations" fuer den Refactoring-Vorschlag (eine gemeinsame
 * `src/domain/customer/create.ts`).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeContact } from "@/api/serializers/contact";
import { listContactsApi, contactListFilterSchema } from "@/domain/customer/list";
import { customerSchema } from "@/schemas";
import { dbInternal } from "@/lib/db";
import { assignCustomerNumber } from "@/domain/numbering/ranges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const result = await listContactsApi(ctx.orgId, Object.fromEntries(searchParams));
  return apiList(result.rows.map(serializeContact), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const v = customerSchema.parse(ctx.body);
  if (v.defaultPaymentMethodId) {
    const method = await dbInternal.paymentMethod.findFirst({ where: { id: v.defaultPaymentMethodId, orgId: ctx.orgId }, select: { id: true } });
    if (!method) throw new z.ZodError([{ code: "custom", path: ["defaultPaymentMethodId"], message: "Zahlungsmethode nicht gefunden." }]);
  }
  const data = {
    type: v.type,
    name: v.name,
    contactName: v.contactName ?? null,
    addressLine1: v.addressLine1,
    addressLine2: v.addressLine2 ?? null,
    postalCode: v.postalCode,
    city: v.city,
    countryCode: v.countryCode,
    email: v.email || null,
    phone: v.phone ?? null,
    vatId: v.vatId ?? null,
    leitwegId: v.leitwegId ?? null,
    defaultPaymentTermsDays: v.defaultPaymentTermsDays ?? null,
    defaultPaymentMethodId: v.defaultPaymentMethodId ?? null,
    notes: v.notes ?? null,
  };
  const created = await dbInternal.$transaction(async (tx) => {
    const customerNumber = v.customerNumber ?? (await assignCustomerNumber(tx, ctx.orgId));
    return tx.customer.create({ data: { ...data, customerNumber, orgId: ctx.orgId } });
  });
  return apiData(serializeContact(created), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Contact",
    method: "GET",
    summary: "Kunden auflisten (Paginierung/Suche)",
    scope: "read",
    request: { query: contactListFilterSchema },
    response: apiListResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
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
