/** GET /api/v1/IncomingInvoice/{id}/file?kind=original|xml — archivierte Datei, nur als Download, nach Hash-Prüfung. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withApi } from "@/api/auth";
import { type RouteSpec } from "@/api/spec";
import { getIncomingFile } from "@/domain/incoming/files";
import { downloadHeaders } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kindSchema = z.enum(["original", "xml"]).default("original");

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const kind = kindSchema.parse(new URL(req.url).searchParams.get("kind") ?? undefined);
  const file = await getIncomingFile(ctx.orgId, ctx.params.id, kind);
  return new NextResponse(new Uint8Array(file.bytes), { headers: downloadHeaders(file.fileName, file.mime, file.bytes.length) });
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/IncomingInvoice/{id}/file",
    method: "GET",
    summary: "Originaldatei (kind=original) oder Rechnungs-XML (kind=xml) herunterladen",
    scope: "read",
    request: { query: z.object({ kind: kindSchema.optional() }) },
    response: z.unknown(),
    binary: { contentType: "application/octet-stream", description: "Datei unverändert aus dem Archiv (Content-Disposition: attachment)." },
    errors: [400, 401, 403, 404, 429, 500],
    errorNotes: { 404: "Auch bei kind=xml ohne Rechnungs-XML.", 500: "ARCHIVE_TAMPERED: Datei fehlt oder stimmt nicht mehr mit dem Hash überein; keine Ausgabe." },
  },
} satisfies Record<string, RouteSpec>;
