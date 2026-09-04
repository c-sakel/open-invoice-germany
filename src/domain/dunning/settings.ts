/**
 * Org-weite Mahnwesen-Einstellungen (Phase 6, Task 1) — analog
 * src/domain/document/settings.ts, aber mit Selbstheilung PER CREATE: anders als
 * DocumentSettings (dort reicht ein In-Memory-Default, solange niemand speichert)
 * braucht der Scheduler (Task 3) eine tatsaechliche Zeile zum Lesen/Sperren je
 * Organisation — deshalb legt `loadDunningSettings` sie beim ersten Zugriff idempotent an.
 */
import { dbInternal } from "@/lib/db";
import { dunningSettingsInputSchema, type DunningSettingsInput } from "@/schemas";

export const DEFAULT_DUNNING_SETTINGS: DunningSettingsInput = {
  autoCreate: true,
  autoSend: false, // §26: Default AUS; Versand nur wenn global UND je Stufe aktiv
  baseInterestRateBp: 127, // 1,27 % — aktueller Basiszinssatz zum Planungszeitpunkt
  baseRateValidFrom: null,
  gracePeriodDays: 0,
};

function toInput(row: {
  autoCreate: boolean;
  autoSend: boolean;
  baseInterestRateBp: number;
  baseRateValidFrom: Date | null;
  gracePeriodDays: number;
}): DunningSettingsInput {
  return dunningSettingsInputSchema.parse({
    autoCreate: row.autoCreate,
    autoSend: row.autoSend,
    baseInterestRateBp: row.baseInterestRateBp,
    baseRateValidFrom: row.baseRateValidFrom ? row.baseRateValidFrom.toISOString().slice(0, 10) : null,
    gracePeriodDays: row.gracePeriodDays,
  });
}

/**
 * Laedt die Mahnwesen-Einstellungen einer Organisation; legt sie mit Defaults an, wenn
 * noch keine Zeile existiert (Selbstheilung, upsert statt find+create wegen Nebenlaeufigkeit).
 */
export async function loadDunningSettings(orgId: string): Promise<DunningSettingsInput> {
  const row = await dbInternal.dunningSettings.upsert({
    where: { orgId },
    create: {
      orgId,
      autoCreate: DEFAULT_DUNNING_SETTINGS.autoCreate,
      autoSend: DEFAULT_DUNNING_SETTINGS.autoSend,
      baseInterestRateBp: DEFAULT_DUNNING_SETTINGS.baseInterestRateBp,
      baseRateValidFrom: DEFAULT_DUNNING_SETTINGS.baseRateValidFrom,
      gracePeriodDays: DEFAULT_DUNNING_SETTINGS.gracePeriodDays,
    },
    update: {},
  });
  return toInput(row);
}

/** Speichert die Mahnwesen-Einstellungen (Upsert, da anfangs keine Zeile existiert). */
export async function saveDunningSettings(orgId: string, rawInput: unknown): Promise<DunningSettingsInput> {
  const input = dunningSettingsInputSchema.parse(rawInput);
  const row = await dbInternal.dunningSettings.upsert({
    where: { orgId },
    create: { orgId, ...input, baseRateValidFrom: input.baseRateValidFrom ? new Date(input.baseRateValidFrom) : null },
    update: { ...input, baseRateValidFrom: input.baseRateValidFrom ? new Date(input.baseRateValidFrom) : null },
  });
  return toInput(row);
}
