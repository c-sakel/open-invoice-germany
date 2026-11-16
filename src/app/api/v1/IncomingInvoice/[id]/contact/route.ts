/** POST /api/v1/IncomingInvoice/{id}/contact — Kontakt aus den Angaben der Rechnung anlegen und zuordnen. */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { withIncomingErrors } from "@/api/incoming-errors";
import { incomingContactResultSchema, serializeCreatedContact } from "@/api/serializers/incoming";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { createContactFromIncoming } from "@/domain/incoming/supplier";
import { incomingContactInputSchema } from "@/schemas/incoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>((_req, ctx) =>
  withIncomingErrors(async () => {
    const r = await createContactFromIncoming(ctx.orgId, ctx.params.id, incomingContactInputSchema.parse(ctx.body ?? {}), ctx.actor);
    const detail = await getIncomingInvoiceDetail(ctx.orgId, ctx.params.id, { ibanMode: "masked" });
    return apiData(serializeCreatedContact({ contactId: r.contactId, detail }), 201);
  }),
{ scope: "write" });

export const spec = {
  contact: {
    path: "/api/v1/IncomingInvoice/{id}/contact",
    method: "POST",
    summary: "Kontakt aus den Angaben der Rechnung anlegen und der Eingangsrechnung zuordnen (Felder aus dem Body überschreiben die Angaben der Datei)",
    scope: "write",
    request: { body: incomingContactInputSchema },
    response: apiDataResponseSchema(incomingContactResultSchema),
    errors: [400, 401, 403, 404, 409, 422, 429, 500],
    errorNotes: {
      409: "ALREADY_ASSIGNED (bereits zugeordnet), STATUS_LOCKED oder STATUS_CONFLICT; Code in error.reason.",
      422: "CONTACT_INCOMPLETE: Angaben fehlen (details.fields, details.prefill); das Land wird nie geraten.",
    },
  },
} satisfies Record<string, RouteSpec>;
