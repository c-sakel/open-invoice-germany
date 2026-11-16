/** GET /api/v1/InboundMail — Anlagen aus dem Rechnungs-Postfach (Sichtung); mit updatedSince Abgleich per Cursor. */
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { inboundMailSchema, serializeInboundMail } from "@/api/serializers/mailbox";
import { listInboundAttachments } from "@/domain/mailbox/list";
import { inboundAttachmentListQuerySchema } from "@/schemas/mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const r = await listInboundAttachments(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
  return apiList(r.items.map(serializeInboundMail), { total: r.total, limit: r.limit, offset: r.offset, ...(r.nextCursor !== null ? { nextCursor: r.nextCursor } : {}) });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/InboundMail",
    method: "GET",
    summary: "Anlagen aus dem Postfach auflisten (neueste zuerst; Filter status; mit updatedSince Abgleich per Cursor)",
    scope: "read",
    request: { query: inboundAttachmentListQuerySchema },
    response: apiListResponseSchema(inboundMailSchema, { sync: true }),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
