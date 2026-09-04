/**
 * POST /api/v1/Invoice/{id}/dunning — naechste Mahnstufe fuer eine Rechnung erstellen.
 * Task 3, task-3-facts.md: ruft exakt `createDunning` (dieselbe Domain-Funktion wie
 * `/api/v1/Dunning` (Task 2) und die Session-Route `/api/invoices/[id]/dunning`).
 * Scope bewusst `send` statt `write` (task-3-brief.md: "Scopes: write fuer
 * zustandsaendernde POST, send fuer /send und dunning send") — eine erstellte Mahnung
 * ist inhaltlich eine an den Kunden gerichtete Zahlungsaufforderung, kein reiner
 * Stammdaten-/Belegschreibvorgang; ein API-Key mit blossem `write`-Scope (z. B. fuer
 * Rechnungsverwaltung) soll keine Mahnungen auf den Weg bringen koennen. `recordDunning`
 * (createDunning) prueft die Organisationszugehoerigkeit selbst ueber `opts.orgId`.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { createDunning } from "@/domain/dunning/create";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  force: z.boolean().optional(),
  lateFeeCents: z.number().int().min(0).optional(),
});

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const input = bodySchema.parse(ctx.body ?? {});
  const res = await createDunning(ctx.params.id, {
    actor: ctx.actor,
    force: input.force,
    lateFeeCents: input.lateFeeCents,
    createdBy: "api",
    orgId: ctx.orgId,
  });
  return apiData({ dunningId: res.dunning.id, number: res.dunning.number, level: res.level, stage: res.stage }, 201);
}, { scope: "send" });

export const spec = {
  create: {
    path: "/api/v1/Invoice/{id}/dunning",
    method: "POST",
    summary: "Naechste Mahnstufe fuer eine Rechnung erstellen",
    scope: "send",
    request: { body: bodySchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
