import { NextResponse } from "next/server";
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
import { invoiceListFilterSchema, createInvoiceRequestSchema, type CreateInvoiceInput, type InvoiceListFilter } from "@/schemas";
import { createDraftInvoice } from "@/domain/invoice/create";
import { createInvoiceComplete } from "@/domain/invoice/create-complete";
import { completeIdempotencyWithinTx, requireIdempotencyKey } from "@/api/idempotency";
import { prisma } from "@/lib/db";
import { apiInvoiceBodyDocSchema, assertGrossPayment, grossResponseFields, resolvePriceInput } from "@/domain/document/price-input";

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
  const priced = resolvePriceInput(ctx.body);
  const request = createInvoiceRequestSchema.parse(priced.body);
  // finalize/payment werden vor der Domain abgetrennt: createInvoiceComplete/createDraftInvoice sehen nur die Rechnungsfelder.
  const { finalize, payment, ...rest } = request;
  const invoiceInput: CreateInvoiceInput = rest;
  if (finalize) assertGrossPayment(priced, payment?.amountCents);
  if (!finalize) {
    const invoice = await createDraftInvoice(ctx.orgId, invoiceInput, { actor: ctx.actor });
    const full = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    return apiData({ ...serializeInvoice(full, new Set()), ...grossResponseFields(priced, full.grossTotalCents) }, 201);
  }
  const key = requireIdempotencyKey(ctx.idempotencyKey, "Idempotency-Key ist bei finalize Pflicht.");
  // Antwort wird in der Transaktion gebaut und als DONE gespeichert (Replay); nach dem Commit wird nichts nachgeladen.
  let body: unknown;
  await createInvoiceComplete(ctx.orgId, invoiceInput, {
    payment,
    actor: ctx.actor,
    createdBy: "api",
    beforeCommit: async (tx, r) => {
      body = { data: { ...serializeInvoice(r.invoice, new Set(["lines", "payments"])), ...grossResponseFields(priced, r.invoice.grossTotalCents) }, warnings: r.warnings };
      await completeIdempotencyWithinTx(tx, ctx.orgId, key, 201, body);
    },
  });
  return NextResponse.json(body, { status: 201 });
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
    summary: "Rechnung anlegen (Entwurf) oder mit finalize: true atomar festschreiben und optional Zahlung erfassen — Idempotency-Key Pflicht bei finalize. Zeilen: Netto in Cent oder tausendstel Cent, alternativ Bruttopreise (Antwort mit grossTargetCents/grossDeviationCents; 400 GROSS_DEVIATION, wenn die Zahlung nicht zum Rechnungsbrutto passt)",
    scope: "write",
    request: { body: apiInvoiceBodyDocSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
