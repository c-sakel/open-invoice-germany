import { z } from "zod";
import { NextResponse } from "next/server";
import { withApi } from "@/api/auth";
import { type RouteSpec } from "@/api/spec";
import { layoutPreviewCheckedSchema, renderLayoutPreview } from "@/domain/layout-design/preview";
import { isLayoutId } from "@/lib/pdf/layouts/ids";
import { ValidationError } from "@/domain/errors";

import { rateLimit } from "@/lib/rate-limit";

const PREVIEW_RATE_LIMIT = 30;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST, weil die Vorschau eine ungespeicherte Konfiguration im Body annimmt; schreibt nichts (Scope read). */
export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  if (isLayoutId(ctx.params.id)) throw new ValidationError("Vorlagen haben keine Design-Vorschau — Design aus Vorlage anlegen.");
  // PDF-Rendern ist teuer: eigenes Kontingent je Schluessel zusaetzlich zum allgemeinen API-Limit (RateLimitError -> 429).
  rateLimit(`layout-preview:${ctx.apiKey.id}`, { limit: PREVIEW_RATE_LIMIT, windowMs: 60_000 });
  const pdf = await renderLayoutPreview(ctx.orgId, ctx.params.id, ctx.body ?? {});
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": 'inline; filename="layout-vorschau.pdf"', "cache-control": "no-store" },
  });
}, { scope: "read" });

export const spec = {
  preview: {
    path: "/api/v1/Layout/{id}/preview",
    method: "POST",
    summary: "Vorschau-PDF eines Designs (Musterbeleg oder Entwurfsrechnung, Wasserzeichen VORSCHAU); `config` (ungespeichert) und `version` schliessen sich aus",
    scope: "read",
    request: { body: layoutPreviewCheckedSchema },
    response: z.unknown(),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
