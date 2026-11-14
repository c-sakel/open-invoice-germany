/**
 * /api/v1/Contact/{id}/portal-link — Kundenportal-Link: Status lesen, anlegen (rotiert einen aktiven Link),
 * widerrufen. Der Status enthaelt weder Token noch URL; die URL liefern nur Anlage und `reveal`.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { portalLinkSchema, portalLinkWithUrlSchema, serializePortalLink } from "@/api/serializers/portal";
import { assertPortalCustomer } from "@/domain/portal/access";
import { createPortalLink, getPortalLinkStatus, revokePortalLink } from "@/domain/portal/link";
import { resolveBaseUrl } from "@/lib/http/base-url";
import { createPortalLinkInputSchema } from "@/schemas/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  await assertPortalCustomer(ctx.orgId, ctx.params.id);
  const status = await getPortalLinkStatus(ctx.orgId, ctx.params.id);
  return apiData(status ? serializePortalLink(status) : null);
}, { scope: "read" });

export const POST = withApi<{ id: string }>(async (req, ctx) => {
  const { link, url } = await createPortalLink(ctx.orgId, ctx.params.id, ctx.body ?? {}, {
    actor: ctx.actor,
    baseUrl: resolveBaseUrl(req.headers),
  });
  return apiData({ link: serializePortalLink(link), url }, 201);
}, { scope: "write", noIdempotency: true });

export const DELETE = withApi<{ id: string }>(async (_req, ctx) => {
  await assertPortalCustomer(ctx.orgId, ctx.params.id);
  const status = await revokePortalLink(ctx.orgId, ctx.params.id, { actor: ctx.actor });
  return apiData(status ? serializePortalLink(status) : null);
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Contact/{id}/portal-link",
    method: "GET",
    summary: "Status des Kundenportal-Links (juengster Link, ohne Token und URL); null ohne Link",
    scope: "read",
    response: apiDataResponseSchema(portalLinkSchema.nullable()),
    errors: [401, 403, 404, 429],
  },
  create: {
    path: "/api/v1/Contact/{id}/portal-link",
    method: "POST",
    summary: "Kundenportal-Link anlegen (ein aktiver Link wird widerrufen) und URL zurueckgeben; ein Idempotency-Key wird ignoriert (die URL wird nie fuer Replays gespeichert)",
    scope: "write",
    request: { body: createPortalLinkInputSchema },
    response: apiDataResponseSchema(portalLinkWithUrlSchema),
    errors: [400, 401, 403, 404, 409, 429],
    errorNotes: { 409: "reason PORTAL_DISABLED (Portal ausgeschaltet) oder CUSTOMER_ARCHIVED." },
  },
  revoke: {
    path: "/api/v1/Contact/{id}/portal-link",
    method: "DELETE",
    summary: "Aktiven Kundenportal-Link widerrufen; null ohne aktiven Link",
    scope: "write",
    response: apiDataResponseSchema(portalLinkSchema.nullable()),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
