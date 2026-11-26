import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeRecurring, recurringSchema } from "@/api/serializers/recurring";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { updateRecurringSchema } from "@/schemas";
import { prisma, dbInternal } from "@/lib/db";
import { findPreviewBasis } from "@/domain/recurring/last-billed";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const row = await prisma.recurringInvoice.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!row) throw new NotFoundError("Abo nicht gefunden.");
  const basis = await findPreviewBasis(dbInternal, row);
  return apiData(serializeRecurring(row, basis.previousEnd, basis.anchorDay));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  const updated = await updateRecurringInvoice(ctx.orgId, ctx.params.id, ctx.body, ctx.actor);
  return apiData(serializeRecurring(updated));
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Recurring/{id}",
    method: "GET",
    summary: "Abo abrufen",
    scope: "read",
    response: apiDataResponseSchema(recurringSchema),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/Recurring/{id}",
    method: "PATCH",
    summary: "Abo aktualisieren (Wechsel der Abrechnungsart mit bereits erzeugten Rechnungen: 409 TIMING_CHANGE_UNACKNOWLEDGED mit details.gapDays/overlapDays, bestaetigen per acknowledgeTimingChange)",
    scope: "write",
    request: { body: updateRecurringSchema },
    response: apiDataResponseSchema(recurringSchema),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
