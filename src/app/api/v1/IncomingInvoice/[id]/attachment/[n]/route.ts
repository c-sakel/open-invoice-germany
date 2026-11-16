/** GET /api/v1/IncomingInvoice/{id}/attachment/{n} — eingebettete Anlage (BG-24) aus der archivierten XML, nur als Download. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withApi } from "@/api/auth";
import { type RouteSpec } from "@/api/spec";
import { NotFoundError } from "@/domain/errors";
import { getIncomingAttachment } from "@/domain/incoming/files";
import { downloadHeaders } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string; n: string }>(async (_req, ctx) => {
  if (!/^\d{1,3}$/.test(ctx.params.n)) throw new NotFoundError("Anlage nicht gefunden.");
  const file = await getIncomingAttachment(ctx.orgId, ctx.params.id, Number(ctx.params.n));
  return new NextResponse(new Uint8Array(file.bytes), { headers: downloadHeaders(file.fileName, file.mime, file.bytes.length) });
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/IncomingInvoice/{id}/attachment/{n}",
    method: "GET",
    summary: "Eingebettete Anlage n (0-basiert) herunterladen",
    scope: "read",
    response: z.unknown(),
    binary: { contentType: "application/octet-stream", description: "Anlage aus der Rechnungs-XML (Content-Disposition: attachment)." },
    errors: [401, 403, 404, 429, 500],
  },
} satisfies Record<string, RouteSpec>;
