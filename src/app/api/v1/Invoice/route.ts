import { z } from "zod";
import { csvListResponse } from "@/api/csv-list";
import { csvFormatQuery } from "@/domain/export";
import { withApi } from "@/api/auth";
import { coerceBooleans, queryObject } from "@/api/query";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeInvoice } from "@/api/serializers/invoice";
import { parseEmbed } from "@/api/serializers/common";
import { listInvoices } from "@/domain/invoice/list";
import { invoiceListFilterSchema, createInvoiceSchema, type InvoiceListFilter } from "@/schemas";
import { createDraftInvoice } from "@/domain/invoice/create";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const csv = await csvListResponse(ctx.orgId, "invoices", searchParams, (raw) => coerceBooleans(raw, ["eInvoice"]));
  if (csv) return csv;
  const embed = parseEmbed(searchParams);
  const result = await listInvoices(ctx.orgId, queryObject(searchParams, ["eInvoice"]) as InvoiceListFilter);
  // Die Liste liefert die volle Form von invoiceSchema: listInvoices (schmales select) dient nur
  // Filter/Sortierung/Paginierung, die Datensaetze werden in EINEM Query nachgeladen.
  const ids = result.rows.map((r) => r.id);
  const full = await prisma.invoice.findMany({
    where: { id: { in: ids }, orgId: ctx.orgId },
    include: { lines: embed.has("lines"), customer: embed.has("customer"), payments: embed.has("payments") },
  });
  const byId = new Map(full.map((i) => [i.id, i]));
  const rows = ids.flatMap((id) => {
    const inv = byId.get(id);
    return inv ? [serializeInvoice(inv, embed)] : [];
  });
  return apiList(rows, result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const input = createInvoiceSchema.parse(ctx.body);
  const invoice = await createDraftInvoice(ctx.orgId, input, { actor: ctx.actor });
  const full = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  return apiData(serializeInvoice(full, new Set()), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Invoice",
    method: "GET",
    summary: "Rechnungen auflisten (Paginierung/Filter/embed=customer,lines,payments); Abgleich: updatedSince + cursor; format=csv liefert text/csv (max. 20.000 Zeilen)",
    scope: "read",
    request: { query: invoiceListFilterSchema.extend(csvFormatQuery) },
    response: apiListResponseSchema(z.unknown(), { sync: true }),
    errors: [400, 401, 403, 413, 429],
    alternateContent: { "text/csv": { description: "Bei format=csv: CSV (UTF-8 mit BOM, Semikolon, CRLF), gleiche Filter wie die Liste ohne Paginierung, max. 20.000 Zeilen" } },
  },
  create: {
    path: "/api/v1/Invoice",
    method: "POST",
    summary: "Rechnung anlegen (Entwurf)",
    scope: "write",
    request: { body: createInvoiceSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
