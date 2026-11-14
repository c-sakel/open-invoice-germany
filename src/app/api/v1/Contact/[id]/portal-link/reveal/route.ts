/**
 * POST /api/v1/Contact/{id}/portal-link/reveal — URL des aktiven Portal-Links erneut abrufen (404 ohne aktiven Link).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { portalUrlSchema } from "@/api/serializers/portal";
import { NotFoundError } from "@/domain/errors";
import { assertPortalCustomer } from "@/domain/portal/access";
import { revealPortalUrl } from "@/domain/portal/link";
import { resolveBaseUrl } from "@/lib/http/base-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (req, ctx) => {
  await assertPortalCustomer(ctx.orgId, ctx.params.id);
  const url = await revealPortalUrl(ctx.orgId, ctx.params.id, resolveBaseUrl(req.headers));
  if (!url) throw new NotFoundError("Kein aktiver Portal-Link vorhanden.");
  return apiData({ url });
}, { scope: "write" });

export const spec = {
  reveal: {
    path: "/api/v1/Contact/{id}/portal-link/reveal",
    method: "POST",
    summary: "URL des aktiven Kundenportal-Links erneut abrufen",
    scope: "write",
    response: apiDataResponseSchema(portalUrlSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
