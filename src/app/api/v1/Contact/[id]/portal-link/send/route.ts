/**
 * POST /api/v1/Contact/{id}/portal-link/send — aktiven Kundenportal-Link per E-Mail an den Kunden senden.
 * Empfaenger: `to` > Rechnungs-E-Mail > E-Mail des Kunden. Ohne aktiven Link 409 NO_ACTIVE_LINK.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { requirePortalBaseUrl } from "@/domain/portal/link";
import { InvalidOperationError } from "@/domain/errors";
import { sendPortalLinkEmail } from "@/domain/portal/mail";
import { assertPortalCustomer } from "@/domain/portal/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ to: z.string().trim().email().max(254).optional() });
const responseSchema = z.object({ emailLogId: z.string(), status: z.enum(["SENT", "FAILED"]), to: z.string() });

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  await assertPortalCustomer(ctx.orgId, ctx.params.id);
  const body = bodySchema.parse(ctx.body ?? {});
  const res = await sendPortalLinkEmail(ctx.orgId, ctx.params.id, {
    actor: ctx.actor,
    to: body.to,
    baseUrl: requirePortalBaseUrl(),
  });
  if (res.status === "FAILED") throw new InvalidOperationError(`Versand fehlgeschlagen (Protokoll ${res.logId}): ${res.error ?? "unbekannt"}`);
  return apiData({ emailLogId: res.logId, status: res.status, to: res.to });
}, { scope: "send" });

export const spec = {
  send: {
    path: "/api/v1/Contact/{id}/portal-link/send",
    method: "POST",
    summary: "Aktiven Kundenportal-Link per E-Mail an den Kunden senden",
    scope: "send",
    request: { body: bodySchema },
    response: apiDataResponseSchema(responseSchema),
    errors: [400, 401, 403, 404, 409, 429],
    errorNotes: { 409: "Versand fehlgeschlagen (Protokoll-ID in der Meldung) oder reason PORTAL_DISABLED, NO_ACTIVE_LINK, NO_RECIPIENT, NO_BASE_URL oder CUSTOMER_ARCHIVED; Mailversand nicht eingerichtet siehe Fehlercode." },
  },
} satisfies Record<string, RouteSpec>;
