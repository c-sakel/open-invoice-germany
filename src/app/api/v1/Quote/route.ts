/**
 * /api/v1/Quote — Angebote (Quote-Modell mit kind=ANGEBOT, task-2-facts.md Registry:
 * Quote/OrderConfirmation teilen sich dieselbe Prisma-Tabelle, unterschieden per `kind`
 * — siehe /api/v1/OrderConfirmation fuer kind=AUFTRAGSBESTAETIGUNG). `kind` wird server-
 * seitig erzwungen, ein vom Client mitgeschickter Wert wird ignoriert/ueberschrieben.
 */
import { z } from "zod";
import { csvListResponse } from "@/api/csv-list";
import { csvFormatQuery } from "@/domain/export";
import { withApi } from "@/api/auth";
import { queryObject } from "@/api/query";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeQuote } from "@/api/serializers/document";
import { parseEmbed } from "@/api/serializers/common";
import { listQuotes, quoteListFilterSchema } from "@/domain/document/list";
import { createBusinessDocument } from "@/domain/document/create";
import { createDocumentSchema } from "@/schemas";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const csv = await csvListResponse(ctx.orgId, "quotes", searchParams);
  if (csv) return csv;
  const embed = parseEmbed(searchParams);
  const raw = { ...queryObject(searchParams, ["includeArchived"]), kind: "ANGEBOT" };
  const result = await listQuotes(ctx.orgId, raw);
  const ids = result.rows.map((r) => r.id);
  const full = await prisma.quote.findMany({
    where: { id: { in: ids }, orgId: ctx.orgId },
    include: { lines: embed.has("lines"), customer: embed.has("customer") },
  });
  const byId = new Map(full.map((q) => [q.id, q]));
  const rows = ids.flatMap((id) => {
    const q = byId.get(id);
    return q ? [serializeQuote(q, "Quote", embed)] : [];
  });
  return apiList(rows, result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const input = createDocumentSchema.parse({ ...(ctx.body as object), kind: "ANGEBOT" });
  const doc = await createBusinessDocument(ctx.orgId, input, { actor: ctx.actor });
  const full = await prisma.quote.findUniqueOrThrow({ where: { id: doc.id } });
  return apiData(serializeQuote(full, "Quote", new Set()), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Quote",
    method: "GET",
    summary: "Angebote auflisten (Paginierung/Filter/embed=customer,lines); Abgleich: updatedSince + cursor; format=csv liefert text/csv (max. 20.000 Zeilen)",
    scope: "read",
    request: { query: quoteListFilterSchema.extend(csvFormatQuery) },
    response: apiListResponseSchema(z.unknown(), { sync: true }),
    errors: [400, 401, 403, 413, 429],
    alternateContent: { "text/csv": { description: "Bei format=csv: CSV (UTF-8 mit BOM, Semikolon, CRLF), gleiche Filter wie die Liste ohne Paginierung, max. 20.000 Zeilen" } },
  },
  create: {
    path: "/api/v1/Quote",
    method: "POST",
    summary: "Angebot anlegen (Entwurf)",
    scope: "write",
    request: { body: createDocumentSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
