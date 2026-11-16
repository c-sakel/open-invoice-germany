/**
 * GET /api/v1/IncomingInvoice/export?from&to&includeRejected — Übergabe an die Buchhaltung als ZIP
 * (Originale + Tabelle, nach Eingangsdatum). Das statische Segment hat Vorrang vor [id].
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { withIncomingErrors } from "@/api/incoming-errors";
import { incomingHandoverResponse } from "@/api/incoming-handover-response";
import { type RouteSpec } from "@/api/spec";
import { incomingHandoverQuerySchema } from "@/schemas/incoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi((req, ctx) =>
  withIncomingErrors(() => incomingHandoverResponse(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams))),
{ scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/IncomingInvoice/export",
    method: "GET",
    summary: "Übergabe an die Buchhaltung: ZIP mit den Originalen und einer Tabelle für einen Zeitraum von höchstens 366 Tagen (ohne interne Notizen)",
    scope: "read",
    request: { query: incomingHandoverQuerySchema },
    // ZIP-Bytes statt {data}-Umschlag.
    response: z.unknown(),
    binary: { contentType: "application/zip", description: "ZIP mit belege/, eingangsrechnungen.csv und liesmich.txt" },
    errors: [400, 401, 403, 413, 429, 500],
    errorNotes: { 413: "Mehr als 2.000 Dateien oder 500 MB: Zeitraum verkleinern." },
  },
} satisfies Record<string, RouteSpec>;
