/**
 * /api/v1/DatevExport — DATEV-Export als Datei (Buchungsstapel, Debitoren, Protokoll; ZIP).
 * GET: Protokoll der Laeufe (Scope read). POST: Lauf oder Vorschau (`dryRun`), Scope admin (Bulk personenbezogener
 * Daten, vergibt Debitorennummern). Die Bestaetigung der Kontenzuordnung gibt es nur in der Oberflaeche.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { datevExportSchema, datevPlanSchema, serializeDatevExport, serializeDatevPlan } from "@/api/serializers/datev";
import { listDatevExports, planDatevExport, runDatevExport } from "@/domain/export/datev/run";
import { dbInternal } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { datevExportRequestSchema, datevListQuerySchema } from "@/schemas/datev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const q = datevListQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const [rows, total] = await Promise.all([
    listDatevExports(ctx.orgId, { limit: q.limit, offset: q.offset }),
    dbInternal.datevExport.count({ where: { orgId: ctx.orgId } }),
  ]);
  return apiList(rows.map(serializeDatevExport), { total, limit: q.limit, offset: q.offset });
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  rateLimit(`datev-export:${ctx.orgId}`, { limit: 10, windowMs: 60_000 });
  const input = datevExportRequestSchema.parse(ctx.body ?? {});
  if (input.dryRun === true) return apiData(serializeDatevPlan(await planDatevExport(ctx.orgId, input)), 200);
  return apiData(serializeDatevExport(await runDatevExport(ctx.orgId, input, ctx.actor)), 201);
}, { scope: "admin" });

export const spec = {
  list: {
    path: "/api/v1/DatevExport",
    method: "GET",
    summary: "Protokoll der DATEV-Exportlaeufe (neueste zuerst)",
    scope: "read",
    request: { query: datevListQuerySchema },
    response: apiListResponseSchema(datevExportSchema),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/DatevExport",
    method: "POST",
    summary: "DATEV-Export erzeugen (Monate im Berliner Kalender, ohne laufenden Monat); dryRun=true liefert nur die Vorschau und schreibt nichts",
    scope: "admin",
    request: { body: datevExportRequestSchema },
    response: apiDataResponseSchema(z.union([datevExportSchema, datevPlanSchema])),
    errors: [400, 401, 403, 404, 409, 422, 429],
    errorNotes: {
      409: "ALREADY_EXPORTED (Monate schon exportiert, Wiederholung mit repeat=true) oder NOTHING_TO_EXPORT; fachlicher Code in error.reason.",
      422: "NOT_CONFIRMED (Kontenzuordnung nicht in der Oberflaeche bestaetigt), INVALID_PERIOD oder fehlende Konten (MISSING_*); Liste mit code, key, documents in error.details.issues.",
    },
  },
} satisfies Record<string, RouteSpec>;
