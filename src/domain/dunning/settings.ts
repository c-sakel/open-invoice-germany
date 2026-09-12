/**
 * Org-weite Mahnwesen-Einstellungen (Phase 6, Task 1) — analog
 * src/domain/document/settings.ts, aber mit Selbstheilung PER CREATE: anders als
 * DocumentSettings (dort reicht ein In-Memory-Default, solange niemand speichert)
 * braucht der Scheduler (Task 3) eine tatsaechliche Zeile zum Lesen/Sperren je
 * Organisation — deshalb legt `loadDunningSettings` sie beim ersten Zugriff idempotent an.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { dunningSettingsInputSchema, type DunningSettingsInput } from "@/schemas";
import { upsertBaseRate } from "./base-rate";

type Db = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_DUNNING_SETTINGS: DunningSettingsInput = {
  autoCreate: true,
  autoSend: false, // §26: Default AUS; Versand nur wenn global UND je Stufe aktiv
  baseInterestRateBp: 127, // 1,27 % — aktueller Basiszinssatz zum Planungszeitpunkt
  baseRateValidFrom: null,
  gracePeriodDays: 0,
};

/**
 * B2 (Fix-Welle, Bestandsschutz): `autoCreate` fuer die DunningSettings-Zeile einer Org
 * ist NICHT einfach `true` — eine Bestandsorg (hat beim Anlegen der Zeile bereits
 * mindestens eine festgeschriebene Rechnung) bekommt `autoCreate: false`, eine neue Org
 * (noch keine festgeschriebene Rechnung) bleibt bei `true`. Grund: ohne diese Bremse
 * mahnt der Scheduler beim ersten Start nach einem Deploy (60 s Anlaufzeit) sofort den
 * gesamten Altbestand an — Mahnungen sind danach unveraenderlich (GoBD) und nicht mehr
 * loeschbar. Betrifft NUR die Anlage der Settings-Zeile (`ensureOrgMasterdata` beim
 * Organisationsanlegen, Selbstheilung in `loadDunningSettings`); ein spaeteres manuelles
 * Umschalten in den Einstellungen bleibt unberuehrt.
 */
export async function defaultAutoCreateForOrg(db: Db, orgId: string): Promise<boolean> {
  const finalizedCount = await db.invoice.count({ where: { orgId, status: { not: "DRAFT" } } });
  return finalizedCount === 0;
}

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
  const existing = await dbInternal.dunningSettings.findUnique({ where: { orgId } });
  if (existing) return toInput(existing);
  const autoCreate = await defaultAutoCreateForOrg(dbInternal, orgId);
  const row = await dbInternal.dunningSettings.upsert({
    where: { orgId },
    create: {
      orgId,
      autoCreate,
      autoSend: DEFAULT_DUNNING_SETTINGS.autoSend,
      baseInterestRateBp: DEFAULT_DUNNING_SETTINGS.baseInterestRateBp,
      baseRateValidFrom: DEFAULT_DUNNING_SETTINGS.baseRateValidFrom,
      gracePeriodDays: DEFAULT_DUNNING_SETTINGS.gracePeriodDays,
    },
    update: {},
  });
  return toInput(row);
}

/**
 * Uebernimmt aus `raw` (dem tatsaechlich vom Aufrufer gesendeten, NICHT vorab mit dem
 * aktuellen Stand gemischten Objekt) nur die Schluessel, die dort wirklich vorkommen —
 * ein fehlender Schluessel behaelt `current`s Wert. Noetig, weil `dunningSettingsInputSchema`
 * jedes Feld mit `.default(...)` versieht: ein `.partial().parse({})` wuerde sonst JEDES
 * Feld mit seinem Default zurueckliefern, auch wenn der Aufrufer es gar nicht gesendet hat
 * (dasselbe Muster wie `mergeSentFields` in src/app/api/v1/Settings/route.ts).
 */
function mergeSentFields<T extends Record<string, unknown>>(current: T, raw: Record<string, unknown>, parsed: Partial<T>): T {
  const merged: T = { ...current };
  for (const key of Object.keys(raw)) {
    if (key in parsed) (merged as Record<string, unknown>)[key] = (parsed as Record<string, unknown>)[key];
  }
  return merged;
}

/**
 * Speichert die Mahnwesen-Einstellungen (Teil-Update: `rawInput` muss NUR die
 * tatsaechlich geaenderten Felder enthalten — nicht angegebene bleiben unveraendert).
 *
 * Phase 14a, Task 4 (R6): `baseInterestRateBp`/`baseRateValidFrom` sind seit Task 3 kein
 * Eingabekanal fuer die Verzugszinsberechnung mehr (die liest ausschliesslich
 * `BaseInterestRate`, `src/domain/dunning/base-rate.ts#loadBaseRates`) — die Spalten
 * bleiben aber bestehen (nichts Destruktives, Alt-API-Vertrag). Ein expliziter
 * Schreibvorgang auf eines der beiden Felder (Altschreibweg: MCP `update_dunning_settings`,
 * die interne Route `/api/dunning-settings`, oder der `dunning`-Zweig von
 * `PATCH /api/v1/Settings`) wird deshalb ZUSAETZLICH als Upsert eines
 * `BaseInterestRate`-Eintrags interpretiert (`validFrom = baseRateValidFrom ?? heute`) —
 * eine Quelle der Wahrheit, kein API-Bruch (docs/API.md). Die Pruefung auf `raw` (statt
 * auf das bereits gemergte `input`) ist zwingend: nur so ist ein tatsaechlicher
 * Schreibvorgang von einem lediglich unveraendert mitgefuehrten Altwert unterscheidbar.
 */
export async function saveDunningSettings(orgId: string, rawInput: unknown): Promise<DunningSettingsInput> {
  const current = await loadDunningSettings(orgId);
  const raw = (rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {}) as Record<string, unknown>;
  const parsed = dunningSettingsInputSchema.partial().parse(raw);
  const input = mergeSentFields(current, raw, parsed);

  if ("baseInterestRateBp" in raw || "baseRateValidFrom" in raw) {
    await upsertBaseRate(orgId, {
      validFrom: input.baseRateValidFrom ?? new Date().toISOString().slice(0, 10),
      rateBp: input.baseInterestRateBp,
      source: "Altschreibweg (Mahnwesen-Einstellungen)",
    });
  }

  const row = await dbInternal.dunningSettings.upsert({
    where: { orgId },
    create: { orgId, ...input, baseRateValidFrom: input.baseRateValidFrom ? new Date(input.baseRateValidFrom) : null },
    update: { ...input, baseRateValidFrom: input.baseRateValidFrom ? new Date(input.baseRateValidFrom) : null },
  });
  return toInput(row);
}
