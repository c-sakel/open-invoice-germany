/**
 * /api/v1/Settings — Einstellungen (task-2-facts.md Registry, singulaere Ressource: kein
 * [id]-Unterpfad, siehe task-2-report.md "Deviations"). Buendelt die drei bestehenden
 * Fragment-Domains (Dokument-/Briefpapier-/Druckeinstellungen) unter je einem Schluessel.
 * Scope: `admin` fuer GET UND PATCH (Brief-Ruling "admin fuer ApiKey/Settings" — anders
 * als der sonstige read/write-Split).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";
import { loadBrandingSettings, saveBrandingSettings } from "@/domain/settings/branding";
import { loadPrintSettings, savePrintSettings } from "@/domain/settings/print";
import { documentSettingsInputSchema, brandingSettingsInputSchema, printSettingsInputSchema } from "@/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadAll(orgId: string) {
  const [documents, branding, print] = await Promise.all([loadDocumentSettings(orgId), loadBrandingSettings(orgId), loadPrintSettings(orgId)]);
  return { objectName: "Settings" as const, documents, branding, print };
}

export const GET = withApi(async (_req, ctx) => {
  return apiData(await loadAll(ctx.orgId));
}, { scope: "admin" });

const patchBodySchema = z.object({
  documents: documentSettingsInputSchema.partial().optional(),
  branding: brandingSettingsInputSchema.partial().optional(),
  print: printSettingsInputSchema.partial().optional(),
});

export const PATCH = withApi(async (_req, ctx) => {
  const v = patchBodySchema.parse(ctx.body);
  if (v.documents) await saveDocumentSettings(ctx.orgId, v.documents);
  if (v.branding) await saveBrandingSettings(ctx.orgId, v.branding);
  if (v.print) await savePrintSettings(ctx.orgId, v.print);
  return apiData(await loadAll(ctx.orgId));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/Settings",
    method: "GET",
    summary: "Einstellungen abrufen (Dokumente/Briefpapier/Druck)",
    scope: "admin",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 429],
  },
  update: {
    path: "/api/v1/Settings",
    method: "PATCH",
    summary: "Einstellungsfragmente aktualisieren",
    scope: "admin",
    request: { body: patchBodySchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
