/**
 * Aufraeumen der Zwischenablage. Entfernt werden nur Kopien: verworfene Anlagen nach 30 Tagen, Betreffzeilen im
 * Protokoll nach 180 Tagen und verwaiste Dateien aelter als 24 Stunden. Offene Anlagen (INBOX) und uebernommene
 * werden nie angefasst; das write-once-Archiv wird hier nicht beruehrt.
 */
import { dbInternal } from "@/lib/db";
import { DISCARD_RESTORE_DAYS, ORPHAN_MIN_AGE_HOURS, SUBJECT_RETENTION_DAYS } from "./limits";
import { listStagingFiles, removeStagingFile } from "./staging";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeMailboxStaging(orgId: string, now: Date): Promise<{ purged: number; subjectsCleared: number; orphans: number }> {
  let purged = 0;
  const discarded = await dbInternal.inboundMailAttachment.findMany({
    where: { orgId, status: "DISCARDED", stagingPath: { not: null }, decidedAt: { lt: new Date(now.getTime() - DISCARD_RESTORE_DAYS * DAY_MS) } },
    select: { id: true, stagingPath: true },
    take: 500,
  });
  for (const a of discarded) {
    if (a.stagingPath === null) continue;
    // Dieselbe Datei kann von einer weiteren offenen Anlage genutzt werden (gleicher Hash): dann bleibt sie liegen.
    const shared = await dbInternal.inboundMailAttachment.count({ where: { orgId, stagingPath: a.stagingPath, id: { not: a.id }, status: { in: ["INBOX", "DISCARDED"] } } });
    if (shared === 0) await removeStagingFile(a.stagingPath);
    const upd = await dbInternal.inboundMailAttachment.updateMany({ where: { id: a.id, orgId, status: "DISCARDED", purgedAt: null }, data: { stagingPath: null, purgedAt: now } });
    purged += upd.count;
  }
  const cleared = await dbInternal.inboundMailMessage.updateMany({
    where: { orgId, subject: { not: null }, fetchedAt: { lt: new Date(now.getTime() - SUBJECT_RETENTION_DAYS * DAY_MS) } },
    data: { subject: null },
  });
  let orphans = 0;
  const files = await listStagingFiles(orgId);
  if (files.length > 0) {
    const used = new Set(
      (await dbInternal.inboundMailAttachment.findMany({ where: { orgId, stagingPath: { not: null } }, select: { stagingPath: true } })).map((r) => r.stagingPath),
    );
    const cutoff = now.getTime() - ORPHAN_MIN_AGE_HOURS * 60 * 60 * 1000;
    for (const f of files) {
      if (used.has(f.rel) || f.mtimeMs >= cutoff) continue;
      await removeStagingFile(f.rel);
      orphans += 1;
    }
  }
  return { purged, subjectsCleared: cleared.count, orphans };
}
