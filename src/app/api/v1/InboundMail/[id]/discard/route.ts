/** POST /api/v1/InboundMail/{id}/discard — Anlage verwerfen (protokolliert, 30 Tage umkehrbar, nie gelöscht). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { withMailboxErrors } from "@/api/mailbox-errors";
import { inboundMailSchema, serializeInboundMail } from "@/api/serializers/mailbox";
import { discardInboundAttachment } from "@/domain/mailbox/decide";
import { inboundDiscardInputSchema } from "@/schemas/mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>((_req, ctx) =>
  withMailboxErrors(async () => apiData(serializeInboundMail(await discardInboundAttachment(ctx.orgId, ctx.params.id, ctx.body, ctx.actor)))),
{ scope: "write" });

export const spec = {
  discard: {
    path: "/api/v1/InboundMail/{id}/discard",
    method: "POST",
    summary: "Anlage aus dem Postfach verwerfen (protokolliert, 30 Tage umkehrbar)",
    scope: "write",
    request: { body: inboundDiscardInputSchema },
    response: apiDataResponseSchema(inboundMailSchema),
    errors: [400, 401, 403, 404, 409, 429],
    errorNotes: { 409: "NOT_INBOX oder CONFLICT (Code in error.reason)." },
  },
} satisfies Record<string, RouteSpec>;
