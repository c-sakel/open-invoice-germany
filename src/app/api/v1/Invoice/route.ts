import { z } from "zod";
import { withApi } from "@/api/auth";
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

function parseInvoiceQuery(searchParams: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = Object.fromEntries(searchParams);
  if ("eInvoice" in raw) raw.eInvoice = raw.eInvoice === "true";
  return raw;
}

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const embed = parseEmbed(searchParams);
  const result = await listInvoices(ctx.orgId, parseInvoiceQuery(searchParams) as InvoiceListFilter);
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
    summary: "Rechnungen auflisten (Paginierung/Filter/embed=customer,lines,payments)",
    scope: "read",
    request: { query: invoiceListFilterSchema },
    response: apiListResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
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
