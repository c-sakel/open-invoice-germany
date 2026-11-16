/**
 * /api/v1/IncomingInvoice — Eingangsrechnungen annehmen (POST, Datei als Base64) und auflisten (GET).
 * Die Datei wird unveraendert und unveraenderlich abgelegt; es wird nichts gebucht. Datei hoechstens 15 MB
 * (Body 21 MB). Scope `write` fuer die Annahme.
 */
import { NextResponse } from "next/server";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { withIncomingErrors } from "@/api/incoming-errors";
import { incomingHeaderSchema, incomingReceiveResultSchema, serializeIncomingHeader, serializeReceiveResult } from "@/api/serializers/incoming";
import { decodeIncomingBase64 } from "@/domain/incoming/base64";
import { listIncomingInvoices } from "@/domain/incoming/list";
import { MAX_INCOMING_BYTES, MAX_INCOMING_REST_BODY_BYTES } from "@/domain/incoming/limits";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { incomingListQuerySchema, incomingReceiveInputSchema } from "@/schemas/incoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const r = await listIncomingInvoices(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
  return apiList(r.rows.map(serializeIncomingHeader), { total: r.total, limit: r.limit, offset: r.offset, ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}) });
}, { scope: "read" });

export const POST = withApi((_req, ctx): Promise<NextResponse> =>
  withIncomingErrors(async () => {
    const input = incomingReceiveInputSchema.parse(ctx.body);
    const bytes = decodeIncomingBase64(input.contentBase64, MAX_INCOMING_BYTES);
    const result = await receiveIncomingInvoice(ctx.orgId, bytes, { fileName: input.fileName, channel: "API", actor: ctx.actor });
    return apiData(serializeReceiveResult(result), 201);
  }),
{ scope: "write", maxBodyBytes: MAX_INCOMING_REST_BODY_BYTES });

export const spec = {
  list: {
    path: "/api/v1/IncomingInvoice",
    method: "GET",
    summary: "Eingangsrechnungen auflisten (neueste zuerst; mit updatedSince Abgleich per Cursor)",
    scope: "read",
    request: { query: incomingListQuerySchema },
    response: apiListResponseSchema(incomingHeaderSchema, { sync: true }),
    errors: [400, 401, 403, 429],
  },
  receive: {
    path: "/api/v1/IncomingInvoice",
    method: "POST",
    summary: "Eingangsrechnung (XML, PDF mit eingebetteter XML oder Bild) als Base64 annehmen. Datei höchstens 15 MB (Body 21 MB)",
    scope: "write",
    request: { body: incomingReceiveInputSchema },
    response: apiDataResponseSchema(incomingReceiveResultSchema),
    errors: [400, 401, 403, 409, 413, 422, 429, 503],
    errorNotes: {
      409: "ALREADY_RECEIVED: dieselbe Datei wurde schon angenommen (details.incomingInvoiceId).",
      422: "Dateifehler mit fachlichem Code in error.reason (z. B. FORBIDDEN_MARKUP, ZIP_NOT_SUPPORTED, NOT_UTF8, MALFORMED).",
      503: "Die Annahme ist ausgelastet; später erneut versuchen (Retry-After).",
    },
  },
} satisfies Record<string, RouteSpec>;
