/** GET /api/v1/DatevExport/{id}/file — ZIP des Laufs aus dem Archiv (Scope admin, enthaelt Kundendaten). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withApi } from "@/api/auth";
import { type RouteSpec } from "@/api/spec";
import { readDatevExportFile } from "@/domain/export/datev/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const { bytes, filename } = await readDatevExportFile(ctx.orgId, ctx.params.id);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/zip",
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/DatevExport/{id}/file",
    method: "GET",
    summary: "ZIP eines DATEV-Exports herunterladen (Pruefsumme gegen das Protokoll)",
    scope: "admin",
    // ZIP-Bytes statt {data}-Umschlag.
    response: z.unknown(),
    errors: [401, 403, 404, 429, 500],
    errorNotes: { 500: "FILE_TAMPERED: die Archivdatei fehlt oder stimmt nicht mehr mit dem Protokoll ueberein." },
  },
} satisfies Record<string, RouteSpec>;
