/**
 * /api/v1/Invoice/{id}/payLink — Bezahllink einer Rechnung. GET (read) liefert Status, Versuche und bei
 * aktivem Link die Adresse; POST (write) legt den Link an bzw. reaktiviert ihn. Die Adresse wird nie fuer
 * Idempotenz-Replays gespeichert (POST ignoriert einen Idempotency-Key).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { payLinkSchema, serializePayLink } from "@/api/serializers/online-payment";
import { createInvoicePayLink, loadInvoicePayLink } from "@/domain/online-payment/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializePayLink(await loadInvoicePayLink(ctx.orgId, ctx.params.id, { withUrl: true })));
}, { scope: "read" });

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const { view, created } = await createInvoicePayLink(ctx.orgId, ctx.params.id, ctx.actor);
  return apiData(serializePayLink(view), created ? 201 : 200);
}, { scope: "write", noIdempotency: true });

export const spec = {
  get: {
    path: "/api/v1/Invoice/{id}/payLink",
    method: "GET",
    summary: "Bezahllink der Rechnung: Status, Versuche und (bei aktivem Link) Adresse",
    scope: "read",
    response: apiDataResponseSchema(payLinkSchema),
    errors: [401, 403, 404, 429],
  },
  create: {
    path: "/api/v1/Invoice/{id}/payLink",
    method: "POST",
    summary: "Bezahllink anlegen oder reaktivieren (201 neu, 200 vorhanden); ein Idempotency-Key wird ignoriert",
    scope: "write",
    response: apiDataResponseSchema(payLinkSchema),
    errors: [401, 403, 404, 422, 429],
    errorNotes: { 422: "reason u. a. INVOICE_STATE, LINK_CANCELLED, NONE, ACCOUNT_OFF, CURRENCY, DIRECT_DEBIT, PREPAID, NOT_PAYABLE." },
  },
} satisfies Record<string, RouteSpec>;
