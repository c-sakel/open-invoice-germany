import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeContact } from "@/api/serializers/contact";
import { customerSchema } from "@/schemas";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const row = await dbInternal.customer.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId } });
  if (!row) throw new NotFoundError("Kunde nicht gefunden.");
  return apiData(serializeContact(row));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  const v = customerSchema.partial().parse(ctx.body);
  const existing = await dbInternal.customer.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId } });
  if (!existing) throw new NotFoundError("Kunde nicht gefunden.");
  if (v.defaultPaymentMethodId) {
    const method = await dbInternal.paymentMethod.findFirst({ where: { id: v.defaultPaymentMethodId, orgId: ctx.orgId }, select: { id: true } });
    if (!method) throw new z.ZodError([{ code: "custom", path: ["defaultPaymentMethodId"], message: "Zahlungsmethode nicht gefunden." }]);
  }
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(ctx.body as object)) {
    if (key in v) patch[key] = (v as Record<string, unknown>)[key];
  }
  if ("email" in patch) patch.email = patch.email || null;
  const updated = await dbInternal.customer.update({ where: { id: existing.id }, data: patch });
  return apiData(serializeContact(updated));
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Contact/{id}",
    method: "GET",
    summary: "Kunden abrufen",
    scope: "read",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/Contact/{id}",
    method: "PATCH",
    summary: "Kunden aktualisieren (Stammdaten)",
    scope: "write",
    request: { body: customerSchema.partial() },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
