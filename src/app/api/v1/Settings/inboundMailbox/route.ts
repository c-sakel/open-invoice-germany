/** GET /api/v1/Settings/inboundMailbox — Status des Rechnungs-Postfachs. Zugangsdaten werden nie ausgegeben und nur in der Oberfläche gepflegt. */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { mailboxStatusSchema, serializeMailboxStatus } from "@/api/serializers/mailbox";
import { loadMailboxSettings } from "@/domain/mailbox/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializeMailboxStatus(await loadMailboxSettings(ctx.orgId, { maskUser: true }))), { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Settings/inboundMailbox",
    method: "GET",
    summary: "Status des Rechnungs-Postfachs lesen (Benutzer maskiert, kein Passwort; Einrichtung nur in der Oberfläche)",
    scope: "read",
    response: apiDataResponseSchema(mailboxStatusSchema),
    errors: [401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
