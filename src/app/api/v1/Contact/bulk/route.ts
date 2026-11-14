/**
 * POST /api/v1/Contact/bulk — Sammelanlage von Kunden (Phase 18d). Body `{ contacts: Contact[] }` (1..100),
 * alles oder nichts; nur Anlage (kein Update). `Idempotency-Key` ist Pflicht (Wiederholung liefert dieselbe Antwort).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withApi } from "@/api/auth";
import { requireIdempotencyKey } from "@/api/idempotency";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeContact } from "@/api/serializers/contact";
import { CONTACTS_BULK_MAX, ContactsBulkRejectedError, contactsBulkSchema, createContactsBulk } from "@/domain/import/contacts-bulk";
import { customerSchema } from "@/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) => {
  requireIdempotencyKey(ctx.idempotencyKey, "Idempotency-Key ist bei Sammelanlagen Pflicht.");
  try {
    const created = await createContactsBulk(ctx.orgId, ctx.body, { actor: ctx.actor, source: "API" });
    return apiData({ created: created.length, contacts: created.map(serializeContact) }, 201);
  } catch (e) {
    if (e instanceof ContactsBulkRejectedError) {
      return NextResponse.json(
        { error: { code: "UNPROCESSABLE", message: e.message, details: { errorCount: e.errorCount, errors: e.errors } } },
        { status: 422 },
      );
    }
    throw e;
  }
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Contact/bulk",
    method: "POST",
    summary: `Mehrere Kunden anlegen (1 bis ${CONTACTS_BULK_MAX}, alles oder nichts, nur Anlage; Idempotency-Key Pflicht; bei Fehlern 422 mit Index, Feld und Meldung je Datensatz)`,
    scope: "write",
    request: { body: contactsBulkSchema.extend({ contacts: z.array(customerSchema).min(1).max(CONTACTS_BULK_MAX) }) },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
