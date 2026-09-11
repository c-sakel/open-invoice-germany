/**
 * POST /api/v1/DocumentTemplate/{id}/apply — erzeugt aus einer Vorlage einen neuen
 * Belegentwurf (Phase 13d, Task 5). Ruft `applyTemplate` (src/domain/template/apply.ts)
 * — dieselbe Domain-Funktion wie die UI (Server Action `applyTemplateAction`,
 * src/app/actions/templates-doc.ts): gleiche Validierung, gleiche Steuersatz-Pruefung,
 * gleiche Snapshots/Nummernkreise wie ein regulaer angelegter Beleg, kein Bypass.
 *
 * Antwort ist bewusst NICHT die volle neu erzeugte Ressource (Invoice/Quote/
 * DeliveryNote je nach `docType`) — ein einzelnes `spec.response` kann keine der drei
 * Formen eindeutig referenzieren (anders als `/convert`, siehe `detectResourceUnion`,
 * src/api/openapi.ts — dort ist die Vereinigung ueber alle drei Ressourcen bekannt und
 * abschliessend; hier haengt die tatsaechliche Form zusaetzlich vom docType DIESER
 * Vorlage ab, nicht generisch je Endpunkt). Stattdessen ein kleines Verweisobjekt
 * (`{objectName, docType, id}`, Muster `/send` -> `{emailLogId, status}`) — ein
 * Konsument laedt die vollstaendige Ressource danach ueber `GET
 * /api/v1/{Invoice,Quote,DeliveryNote}/{id}`.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { applyTemplate, TemplateCustomerRequiredError } from "@/domain/template/apply";
import { applyTemplateSchema } from "@/schemas/template";
import { TagDocType } from "@/schemas/tag";
import { InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  try {
    // applyTemplate wirft bei einer fremden/unbekannten Vorlagen-id bereits
    // NotFoundError direkt — keine Uebersetzung noetig. TaxRateNotAllowedError ist
    // bereits in DOMAIN_CONFLICT_ERROR_CLASSES (src/api/errors.ts) auf 409 gemappt.
    const { docType, id } = await applyTemplate(ctx.orgId, ctx.params.id, ctx.body, ctx.actor);
    return apiData({ objectName: "DocumentTemplateApplication" as const, docType, id }, 201);
  } catch (e) {
    if (e instanceof TemplateCustomerRequiredError) throw new InvalidOperationError(e.message);
    throw e;
  }
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/DocumentTemplate/{id}/apply",
    method: "POST",
    summary: "Aus einer Belegvorlage einen neuen Belegentwurf erzeugen",
    scope: "write",
    request: { body: applyTemplateSchema },
    // z.enum(TagDocType.options) statt der importierten TagDocType-Instanz direkt: eine
    // frische Konstruktion HIER (nach dem transitiven openapi-zod-init-Import oben)
    // vermeidet die Reihenfolge-Falle aus src/api/openapi-zod-init.ts (TagDocType selbst
    // entsteht in src/schemas/tag.ts, das openapi-zod-init NICHT zuerst importiert).
    response: apiDataResponseSchema(
      z.object({ objectName: z.literal("DocumentTemplateApplication"), docType: z.enum(TagDocType.options), id: z.string() }),
    ),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
