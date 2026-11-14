/**
 * DELETE /api/v1/Recurring/{id}/usage/{usageId} — Verbrauchssatz stornieren (Phase 18f, Task 7).
 * Der Satz bleibt erhalten (append-only), bekommt Storno-Zeitpunkt, Akteur und Pflichtgrund.
 * withApi liest bei DELETE keinen Body; er wird hier mit eigener Groessengrenze gelesen.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { readJsonLimited } from "@/api/read-json-limited";
import type { RouteSpec } from "@/api/spec";
import { serializeUsage, usageSchema } from "@/api/serializers/recurring-usage";
import { voidUsage } from "@/domain/recurring/usage";
import { voidUsageSchema } from "@/schemas/recurring-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VOID_BODY_BYTES = 4096;

export const DELETE = withApi<{ id: string; usageId: string }>(async (req, ctx) => {
  const body = await readJsonLimited(req, MAX_VOID_BODY_BYTES);
  const view = await voidUsage(ctx.orgId, ctx.params.id, ctx.params.usageId, body, { actor: ctx.actor });
  return apiData(serializeUsage(view));
}, { scope: "write" });

export const spec = {
  void: {
    path: "/api/v1/Recurring/{id}/usage/{usageId}",
    method: "DELETE",
    summary: "Verbrauch stornieren (Pflichtgrund im Body; abgerechnete und bereits stornierte Saetze -> 422)",
    scope: "write",
    request: { body: voidUsageSchema },
    response: z.object({ data: usageSchema }),
    errors: [400, 401, 403, 404, 413, 415, 422, 429],
    errorNotes: {
      404: "Abo oder Verbrauchssatz nicht gefunden (code NOT_FOUND).",
      422: "Fachlicher Code in error.code: ALREADY_VOIDED (bereits storniert) oder ALREADY_BILLED (bereits abgerechnet).",
    },
  },
} satisfies Record<string, RouteSpec>;
