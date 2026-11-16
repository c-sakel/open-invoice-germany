/** GET /api/v1/InboundMail/{id} — eine Anlage aus dem Rechnungs-Postfach (ohne Dateipfad). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { inboundMailSchema, serializeInboundMail } from "@/api/serializers/mailbox";
import { getInboundAttachment } from "@/domain/mailbox/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => apiData(serializeInboundMail(await getInboundAttachment(ctx.orgId, ctx.params.id))), { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/InboundMail/{id}",
    method: "GET",
    summary: "Anlage aus dem Postfach abrufen",
    scope: "read",
    response: apiDataResponseSchema(inboundMailSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
