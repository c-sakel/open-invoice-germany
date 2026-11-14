import { z } from "zod";
import { csvListResponse } from "@/api/csv-list";
import { csvFormatQuery } from "@/domain/export";
import { withApi } from "@/api/auth";
import { queryObject } from "@/api/query";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeDeliveryNote } from "@/api/serializers/delivery-note";
import { parseEmbed } from "@/api/serializers/common";
import { listDeliveryNotes, deliveryNoteListFilterSchema } from "@/domain/document/list";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createDeliveryNoteSchema } from "@/schemas";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const csv = await csvListResponse(ctx.orgId, "delivery-notes", searchParams);
  if (csv) return csv;
  const embed = parseEmbed(searchParams);
  const result = await listDeliveryNotes(ctx.orgId, queryObject(searchParams, ["includeArchived"]));
  const ids = result.rows.map((r) => r.id);
  const full = await prisma.deliveryNote.findMany({
    where: { id: { in: ids }, orgId: ctx.orgId },
    include: { lines: embed.has("lines"), customer: embed.has("customer") },
  });
  const byId = new Map(full.map((d) => [d.id, d]));
  const rows = ids.flatMap((id) => {
    const dn = byId.get(id);
    return dn ? [serializeDeliveryNote(dn, embed)] : [];
  });
  return apiList(rows, result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const input = createDeliveryNoteSchema.parse(ctx.body);
  const note = await createDeliveryNote(ctx.orgId, input, { actor: ctx.actor });
  const full = await prisma.deliveryNote.findUniqueOrThrow({ where: { id: note.id } });
  return apiData(serializeDeliveryNote(full, new Set()), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/DeliveryNote",
    method: "GET",
    summary: "Lieferscheine auflisten (Paginierung/Filter/embed=customer,lines); Abgleich: updatedSince + cursor; format=csv liefert text/csv (max. 20.000 Zeilen)",
    scope: "read",
    request: { query: deliveryNoteListFilterSchema.extend(csvFormatQuery) },
    response: apiListResponseSchema(z.unknown(), { sync: true }),
    errors: [400, 401, 403, 413, 429],
    alternateContent: { "text/csv": { description: "Bei format=csv: CSV (UTF-8 mit BOM, Semikolon, CRLF), gleiche Filter wie die Liste ohne Paginierung, max. 20.000 Zeilen" } },
  },
  create: {
    path: "/api/v1/DeliveryNote",
    method: "POST",
    summary: "Lieferschein anlegen (mit draft: true als Entwurf ohne Nummer, sonst direkt erstellt)",
    scope: "write",
    request: { body: createDeliveryNoteSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
