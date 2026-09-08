/**
 * Raeumt das Anfrageprotokoll auf (Phase 12d, Task 2): der taegliche Job (Scheduler)
 * wendet je Organisation deren `retentionDays` (Zeit) und `maxRows` (Menge) an. Geloescht
 * wird blockweise — SQLite mag keine riesigen IN-Listen. `orderBy` fuehrt `id` als zweites
 * Kriterium, weil SQLite `createdAt` nur auf Millisekunden genau schreibt: bei Gleichstand
 * waere die Reihenfolge sonst unbestimmt und der Schnitt bei `maxRows` nicht reproduzierbar.
 */
import { dbInternal } from "@/lib/db";
import { loadApiSettings } from "./settings";

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 1000;

/** Retention (Zeit + Menge) ueber alle Organisationen; liefert die Anzahl geloeschter Zeilen. */
export async function purgeApiRequestLogs(now: Date = new Date()): Promise<number> {
  const orgs = await dbInternal.apiRequestLog.findMany({ distinct: ["orgId"], select: { orgId: true } });
  let deleted = 0;
  for (const { orgId } of orgs) {
    const { retentionDays, maxRows } = await loadApiSettings(orgId);
    const threshold = new Date(now.getTime() - retentionDays * DAY_MS);
    deleted += (await dbInternal.apiRequestLog.deleteMany({ where: { orgId, createdAt: { lt: threshold } } })).count;

    // Danach auf maxRows kuerzen — blockweise.
    for (;;) {
      const surplus = await dbInternal.apiRequestLog.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: maxRows,
        take: PURGE_BATCH_SIZE,
        select: { id: true },
      });
      if (surplus.length === 0) break;
      deleted += (await dbInternal.apiRequestLog.deleteMany({ where: { id: { in: surplus.map((r) => r.id) } } })).count;
      if (surplus.length < PURGE_BATCH_SIZE) break;
    }
  }
  return deleted;
}

/** Loescht das gesamte Anfrageprotokoll einer Organisation (z.B. beim Deaktivieren). */
export async function clearApiRequestLogs(orgId: string): Promise<number> {
  return (await dbInternal.apiRequestLog.deleteMany({ where: { orgId } })).count;
}
