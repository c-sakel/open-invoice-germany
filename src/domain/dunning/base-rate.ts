/**
 * Basiszinssatz-Historie (Phase 14a, Task 2) — § 288 Abs. 1 Satz 2 BGB: der
 * Basiszinssatz aendert sich zum 1. Januar und 1. Juli eines jeden Jahres. Diese
 * Tabelle ersetzt DunningSettings.baseInterestRateBp/-baseRateValidFrom als Quelle der
 * Verzugszinsberechnung (Task 3) — die alten Spalten bleiben bestehen (nichts
 * Destruktives), werden aber von keiner Berechnung mehr gelesen.
 *
 * `listBaseRates`/`upsertBaseRate`/`deleteBaseRate` sind die CRUD-Operationen fuer die
 * spaetere Verwaltung (REST/MCP/UI, Task 4) — Stammdaten, kein Beleg, daher kein
 * ChangeLog (nur Belegereignisse gehen in die Hash-Kette, Ruling Audit K5).
 *
 * `loadBaseRates` ist der Lesepfad fuer die Zinsberechnung selbst: er heilt fehlende
 * Historien selbst (eine Organisation ohne einen einzigen Eintrag bekaeme sonst nie
 * einen Satz zum Rechnen) — Quelle des einmaligen Backfill-Werts ist die bestehende
 * DunningSettings-Zeile, oder, falls auch die fehlt (Organisation ganz ohne
 * Mahnwesen-Zeile), der Systemdefault 127 bp (DEFAULT_DUNNING_SETTINGS).
 *
 * `rateForDate` ist rein (kein DB-Zugriff) und wird von src/lib/dunning.ts (Task 3,
 * segmentierte Zinsrechnung) sowie von loadBaseRates-Aufrufern verwendet.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { baseInterestRateInputSchema, type BaseInterestRateInput } from "@/schemas";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { DEFAULT_DUNNING_SETTINGS } from "@/domain/dunning/settings";

type Db = PrismaClient | Prisma.TransactionClient;

// Keine Zinsluecke vor dem ersten gepflegten Datum (siehe rateForDate) — derselbe Wert,
// den die Migration fuer Bestandszeilen ohne baseRateValidFrom verwendet hat.
const EPOCH = new Date("1970-01-01T00:00:00.000Z");

export interface BaseRateEntry {
  validFrom: Date;
  rateBp: number;
}

/** Alle Basiszinssaetze einer Organisation, aufsteigend nach validFrom. */
export async function listBaseRates(orgId: string) {
  return dbInternal.baseInterestRate.findMany({
    where: { orgId },
    orderBy: { validFrom: "asc" },
    select: { id: true, validFrom: true, rateBp: true, source: true, createdAt: true, updatedAt: true },
  });
}

/**
 * Legt einen Basiszinssatz an oder ueberschreibt den bestehenden Eintrag mit
 * demselben `validFrom` (Unique auf (orgId, validFrom)) — ein zweiter Eintrag zum
 * gleichen Stichtag waere fachlich unsinnig (welcher Satz gilt dann?) und wuerde sonst
 * den Unique-Constraint verletzen statt die Korrektur eines Tippfehlers zu erlauben.
 *
 * `db` optional (Default `dbInternal`, Muster `loadBaseRates`) — Aufrufer mit einem
 * zweiten, davon abhaengigen Schreibvorgang (`saveDunningSettings`, Fix-Welle 4, should 3)
 * reichen hier ihren `Prisma.TransactionClient` durch, damit beide Schreibvorgaenge
 * atomar sind.
 */
export async function upsertBaseRate(orgId: string, rawInput: unknown, db: Db = dbInternal) {
  const input: BaseInterestRateInput = baseInterestRateInputSchema.parse(rawInput);
  const validFrom = new Date(input.validFrom);
  return db.baseInterestRate.upsert({
    where: { orgId_validFrom: { orgId, validFrom } },
    create: { orgId, validFrom, rateBp: input.rateBp, source: input.source ?? null },
    update: { rateBp: input.rateBp, source: input.source ?? null },
    select: { id: true, validFrom: true, rateBp: true, source: true, createdAt: true, updatedAt: true },
  });
}

/**
 * Loescht einen Basiszinssatz — nicht, wenn er der letzte verbleibende Eintrag der
 * Organisation ist (ValidationError, 400): die Verzugszinsberechnung darf nie ohne
 * Satz dastehen (rateForDate erwartet mindestens einen Eintrag).
 */
export async function deleteBaseRate(orgId: string, id: string): Promise<void> {
  const existing = await dbInternal.baseInterestRate.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!existing) throw new NotFoundError("Basiszinssatz nicht gefunden.");
  const count = await dbInternal.baseInterestRate.count({ where: { orgId } });
  if (count <= 1) {
    throw new ValidationError(
      "Der letzte verbleibende Basiszinssatz kann nicht geloescht werden — fuer die Verzugszinsberechnung ist mindestens ein Eintrag erforderlich.",
    );
  }
  await dbInternal.baseInterestRate.delete({ where: { id } });
}

/**
 * Lesepfad fuer die Zinsberechnung: liefert die Basiszinssatz-Historie einer
 * Organisation, aufsteigend nach validFrom, und heilt eine fehlende Historie selbst
 * (idempotenter Upsert gegen den Unique-Index, kollisionssicher bei Nebenlaeufigkeit).
 * Quelle des einmaligen Werts: die bestehende DunningSettings-Zeile (Bestandswert),
 * sonst der Systemdefault 127 bp fuer Organisationen ganz ohne Mahnwesen-Zeile.
 */
export async function loadBaseRates(db: Db, orgId: string): Promise<BaseRateEntry[]> {
  const existing = await db.baseInterestRate.findMany({
    where: { orgId },
    orderBy: { validFrom: "asc" },
    select: { validFrom: true, rateBp: true },
  });
  if (existing.length > 0) return existing;

  const settings = await db.dunningSettings.findUnique({
    where: { orgId },
    select: { baseInterestRateBp: true, baseRateValidFrom: true },
  });
  const rateBp = settings?.baseInterestRateBp ?? DEFAULT_DUNNING_SETTINGS.baseInterestRateBp;
  const validFrom = settings?.baseRateValidFrom ?? EPOCH;

  const created = await db.baseInterestRate.upsert({
    where: { orgId_validFrom: { orgId, validFrom } },
    // Hotfix (A9, Tiefenanalyse UI/Ausgabe/Bedienung): "source" ist das Quellenfeld des
    // Basiszinssatzes auf der Oberflaeche (Beispiel daneben: "Deutsche Bundesbank") und
    // damit § 288 BGB-relevant — ein Entwicklervermerk ("Selbstheilung Phase 14a") gehoert
    // dort nicht hin. Neutraler deutscher Text statt Implementierungsdetail.
    create: { orgId, validFrom, rateBp, source: "Übernommen aus den Mahnwesen-Einstellungen" },
    update: {},
    select: { validFrom: true, rateBp: true },
  });
  return [created];
}

/**
 * Der fuer `date` gueltige Basiszinssatz: der Eintrag mit dem groessten
 * `validFrom <= date`; existiert keiner (date liegt vor dem ersten Eintrag), der
 * aelteste Eintrag — es wird nie ohne Satz gerechnet. `rates` muss mindestens einen
 * Eintrag enthalten (garantiert durch loadBaseRates); ein leeres Array ist ein
 * Programmierfehler des Aufrufers, keine fachliche Eingabe, daher ValidationError.
 */
export function rateForDate<T extends BaseRateEntry>(rates: readonly T[], date: Date): T {
  if (rates.length === 0) {
    throw new ValidationError("Keine Basiszinssaetze vorhanden — Verzugszins kann nicht berechnet werden.");
  }
  const sorted = [...rates].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  let candidate = sorted[0];
  for (const entry of sorted) {
    if (entry.validFrom.getTime() <= date.getTime()) {
      candidate = entry;
    } else {
      break;
    }
  }
  return candidate;
}
