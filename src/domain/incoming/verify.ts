/**
 * Hash-Pruefung der archivierten Dateien von Eingangsrechnungen (Original und ausgelesene XML).
 * Laeuft in der woechentlichen Kettenpruefung; jede Abweichung loest den Pflicht-Alarm aus.
 */
import { dbInternal } from "@/lib/db";
import { hashArchiveFile } from "@/lib/archive/storage";
import { onIncomingArchiveTampered } from "@/domain/notifications/hooks";

const BLOCK = 200;

export async function verifyIncomingFiles(orgId: string): Promise<{ checked: number; tampered: number }> {
  let checked = 0;
  let tampered = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows: { id: string; originalPath: string; originalSha256: string; xmlPath: string | null; xmlSha256: string | null }[] =
      await dbInternal.incomingInvoice.findMany({
        where: { orgId, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: BLOCK,
        select: { id: true, originalPath: true, originalSha256: true, xmlPath: true, xmlSha256: true },
      });
    if (rows.length === 0) break;
    for (const row of rows) {
      checked++;
      const bad: string[] = [];
      if ((await hashArchiveFile(row.originalPath)) !== row.originalSha256) bad.push("ORIGINAL");
      if (row.xmlPath !== null && row.xmlSha256 !== null && (await hashArchiveFile(row.xmlPath)) !== row.xmlSha256) bad.push("XML");
      if (bad.length > 0) {
        tampered++;
        for (const kind of bad) await onIncomingArchiveTampered(orgId, { incomingInvoiceId: row.id, kind });
      }
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < BLOCK) break;
  }
  return { checked, tampered };
}
