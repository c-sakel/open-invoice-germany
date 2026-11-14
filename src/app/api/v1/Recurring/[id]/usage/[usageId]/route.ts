/**
 * DELETE /api/v1/Recurring/{id}/usage/{usageId} — Verbrauchssatz stornieren (Phase 18f, Task 7).
 * Der Satz bleibt erhalten (append-only), bekommt Storno-Zeitpunkt, Akteur und Pflichtgrund.
 * withApi liest bei DELETE keinen Body; er wird hier mit eigener Groessengrenze gelesen.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { PayloadTooLargeError } from "@/api/errors";
import type { RouteSpec } from "@/api/spec";
import { serializeUsage, usageSchema } from "@/api/serializers/recurring-usage";
import { voidUsage } from "@/domain/recurring/usage";
import { voidUsageSchema } from "@/schemas/recurring-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VOID_BODY_BYTES = 4096;

async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_VOID_BODY_BYTES) {
    throw new PayloadTooLargeError(`Request-Body ueberschreitet das Limit von ${MAX_VOID_BODY_BYTES} Bytes.`);
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_VOID_BODY_BYTES) {
    throw new PayloadTooLargeError(`Request-Body ueberschreitet das Limit von ${MAX_VOID_BODY_BYTES} Bytes.`);
  }
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new z.ZodError([{ code: "custom", path: [], message: "Ungueltiges JSON im Request-Body." }]);
  }
}

export const DELETE = withApi<{ id: string; usageId: string }>(async (req, ctx) => {
  const body = await readJsonBody(req);
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
    errors: [400, 401, 403, 404, 413, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
