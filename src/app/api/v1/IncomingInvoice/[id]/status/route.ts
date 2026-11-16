/** POST /api/v1/IncomingInvoice/{id}/status — Bearbeitungsstatus ändern (Prüfen, Freigeben, Als bezahlt vermerken, Ablehnen, Zurücksetzen). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { withIncomingErrors } from "@/api/incoming-errors";
import { incomingDetailSchema, serializeIncomingDetail } from "@/api/serializers/incoming";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { changeIncomingStatus } from "@/domain/incoming/status";
import { incomingStatusInputSchema } from "@/schemas/incoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>((_req, ctx) =>
  withIncomingErrors(async () => {
    await changeIncomingStatus(ctx.orgId, ctx.params.id, incomingStatusInputSchema.parse(ctx.body), ctx.actor);
    return apiData(serializeIncomingDetail(await getIncomingInvoiceDetail(ctx.orgId, ctx.params.id, { ibanMode: "masked" })));
  }),
{ scope: "write" });

export const spec = {
  status: {
    path: "/api/v1/IncomingInvoice/{id}/status",
    method: "POST",
    summary: "Bearbeitungsstatus ändern (CHECK, APPROVE, MARK_PAID, REJECT, REVERT). MARK_PAID ist nur ein Merker, es wird nichts gebucht",
    scope: "write",
    request: { body: incomingStatusInputSchema },
    response: apiDataResponseSchema(incomingDetailSchema),
    errors: [400, 401, 403, 404, 409, 429, 500],
    errorNotes: {
      400: "REASON_REQUIRED (Grund fehlt oder nicht 3 bis 500 Zeichen), PAID_DATE_INVALID, NOTE_TOO_LONG; Code in error.reason.",
      409: "INVALID_TRANSITION (Aktion im Status nicht möglich) oder STATUS_CONFLICT (zwischenzeitlich geändert); Code in error.reason.",
    },
  },
} satisfies Record<string, RouteSpec>;
