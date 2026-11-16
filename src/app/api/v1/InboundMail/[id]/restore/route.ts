/** POST /api/v1/InboundMail/{id}/restore — verworfene Anlage zurück in die Sichtung (innerhalb von 30 Tagen). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { withMailboxErrors } from "@/api/mailbox-errors";
import { inboundMailSchema, serializeInboundMail } from "@/api/serializers/mailbox";
import { restoreInboundAttachment } from "@/domain/mailbox/decide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>((_req, ctx) =>
  withMailboxErrors(async () => apiData(serializeInboundMail(await restoreInboundAttachment(ctx.orgId, ctx.params.id, ctx.actor)))),
{ scope: "write" });

export const spec = {
  restore: {
    path: "/api/v1/InboundMail/{id}/restore",
    method: "POST",
    summary: "Verworfene Anlage zurück in die Sichtung holen",
    scope: "write",
    response: apiDataResponseSchema(inboundMailSchema),
    errors: [401, 403, 404, 409, 429],
    errorNotes: { 409: "NOT_INBOX, PURGED (Kopie bereits entfernt) oder CONFLICT (Code in error.reason)." },
  },
} satisfies Record<string, RouteSpec>;
