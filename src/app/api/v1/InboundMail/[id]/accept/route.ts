/** POST /api/v1/InboundMail/{id}/accept — Anlage als Eingangsrechnung übernehmen (dieselbe Annahme wie der Upload, Kanal MAILBOX). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { withMailboxErrors } from "@/api/mailbox-errors";
import { incomingReceiveResultSchema, serializeReceiveResult } from "@/api/serializers/incoming";
import { acceptInboundAttachment } from "@/domain/mailbox/decide";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>((_req, ctx) =>
  withMailboxErrors(async () => {
    const r = await acceptInboundAttachment(ctx.orgId, ctx.params.id, ctx.actor);
    return apiData({ incomingInvoiceId: r.incomingInvoiceId, incomingInvoice: serializeReceiveResult(r.result) }, 201);
  }),
{ scope: "write" });

export const spec = {
  accept: {
    path: "/api/v1/InboundMail/{id}/accept",
    method: "POST",
    summary: "Anlage aus dem Postfach als Eingangsrechnung übernehmen (write-once-Ablage, Kanal MAILBOX)",
    scope: "write",
    response: apiDataResponseSchema(z.object({ incomingInvoiceId: z.string(), incomingInvoice: incomingReceiveResultSchema })),
    errors: [401, 403, 404, 409, 413, 422, 429, 500, 503],
    errorNotes: {
      409: "NOT_INBOX, CONFLICT oder STAGING_MISSING (Code in error.reason); ALREADY_RECEIVED mit details.incomingInvoiceId.",
      422: "Dateifehler mit fachlichem Code in error.reason; die Anlage bleibt in der Sichtung.",
    },
  },
} satisfies Record<string, RouteSpec>;
