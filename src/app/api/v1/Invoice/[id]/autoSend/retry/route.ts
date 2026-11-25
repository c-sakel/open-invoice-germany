/**
 * POST /api/v1/Invoice/{id}/autoSend/retry — automatischen Versand einer Abo-Rechnung neu starten
 * (UNCLEAR, GAVE_UP, NO_ADDRESS, BOUNCED). Bei UNCLEAR nur mit `confirmUnclear: true`: die Mail kann doppelt ankommen.
 * Dieselbe Domainfunktion und dasselbe Schema wie Belegansicht und MCP-Tool `retry_invoice_auto_send`.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { retryAutoSendInputSchema, retryInvoiceAutoSend, publicAutoSend } from "@/domain/recurring/auto-send-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseSchema = z.object({
  status: z.string().describe("Zustand nach dem Neustart (SENT, RETRY, UNCLEAR, ...)"),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const view = await retryInvoiceAutoSend(ctx.orgId, ctx.params.id, ctx.actor, ctx.body);
  return apiData(publicAutoSend(view));
}, { scope: "send" });

export const spec = {
  retry: {
    path: "/api/v1/Invoice/{id}/autoSend/retry",
    method: "POST",
    summary: "Automatischen Versand neu starten (Body optional; bei unklarem Ausgang confirmUnclear: true)",
    scope: "send",
    request: { body: retryAutoSendInputSchema },
    response: apiDataResponseSchema(responseSchema),
    errors: [400, 401, 403, 404, 409, 429],
    errorNotes: {
      404: "reason NO_AUTO_SEND: Rechnung unbekannt oder ohne automatischen Versand.",
      409: "reason NOT_RETRYABLE (Zustand erlaubt keinen Neustart), CONFIRM_REQUIRED (unklarer Ausgang ohne confirmUnclear), STATE_CHANGED.",
    },
  },
} satisfies Record<string, RouteSpec>;
