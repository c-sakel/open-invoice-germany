/**
 * POST /api/v1/Contact/{id}/portal-link/reveal — URL des aktiven Portal-Links erneut abrufen (404 ohne aktiven Link).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { portalUrlSchema } from "@/api/serializers/portal";
import { NotFoundError } from "@/domain/errors";
import { assertPortalCustomer } from "@/domain/portal/access";
import { requirePortalBaseUrl, revealPortalUrl } from "@/domain/portal/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  await assertPortalCustomer(ctx.orgId, ctx.params.id);
  const url = await revealPortalUrl(ctx.orgId, ctx.params.id, requirePortalBaseUrl());
  if (!url) throw new NotFoundError("Kein aktiver Portal-Link vorhanden.");
  return apiData({ url });
}, { scope: "write", noIdempotency: true });

export const spec = {
  reveal: {
    path: "/api/v1/Contact/{id}/portal-link/reveal",
    method: "POST",
    summary: "URL des aktiven Kundenportal-Links erneut abrufen (ein Idempotency-Key wird ignoriert)",
    scope: "write",
    response: apiDataResponseSchema(portalUrlSchema),
    errors: [401, 403, 404, 409, 429],
    errorNotes: { 409: "reason NO_BASE_URL (APP_BASE_URL nicht gesetzt)." },
  },
} satisfies Record<string, RouteSpec>;
