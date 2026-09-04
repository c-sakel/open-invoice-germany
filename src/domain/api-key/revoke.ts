/** Widerruf eines API-Schluessels (Phase 10, Task 1) — org-gescoped, idempotent. */
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";

export async function revokeApiKey(orgId: string, id: string): Promise<void> {
  const row = await dbInternal.apiKey.findFirst({ where: { id, orgId } });
  if (!row) throw new NotFoundError(`API-Schluessel "${id}" nicht gefunden.`);
  if (row.revokedAt) return; // bereits widerrufen -> idempotent, kein Fehler
  await dbInternal.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}
