/**
 * Org-weite Einstellungen fuer das Anfrageprotokoll der REST-API (Phase 12d, Task 1):
 * ob Anfragen ueberhaupt protokolliert werden (`logRequests`, Default AUS), ob dabei
 * auch Request-/Response-Bodies gespeichert werden (`logBodies`), Aufbewahrung
 * (`retentionDays`) und Obergrenze der Zeilen je Organisation (`maxRows`). Ohne
 * gespeicherte Zeile gelten die Defaults — keine Migration noetig, bevor eine
 * Organisation die Einstellungen zum ersten Mal oeffnet (Selbstheilung wie
 * src/domain/document/settings.ts).
 */
import { dbInternal } from "@/lib/db";
import { apiSettingsInputSchema, type ApiSettingsInput } from "@/schemas/api-log";

export const DEFAULT_API_SETTINGS: ApiSettingsInput = apiSettingsInputSchema.parse({});

/** Laedt die API-Protokoll-Einstellungen einer Organisation; Defaults, wenn noch keine Zeile existiert. */
export async function loadApiSettings(orgId: string): Promise<ApiSettingsInput> {
  const row = await dbInternal.apiSettings.findUnique({ where: { orgId } });
  if (!row) return DEFAULT_API_SETTINGS;
  return apiSettingsInputSchema.parse({
    logRequests: row.logRequests,
    logBodies: row.logBodies,
    retentionDays: row.retentionDays,
    maxRows: row.maxRows,
  });
}

/** Speichert die API-Protokoll-Einstellungen (Upsert, da anfangs keine Zeile existiert). */
export async function saveApiSettings(orgId: string, raw: unknown): Promise<ApiSettingsInput> {
  const input = apiSettingsInputSchema.parse(raw);
  await dbInternal.apiSettings.upsert({
    where: { orgId },
    create: { orgId, ...input },
    update: { ...input },
  });
  return input;
}
