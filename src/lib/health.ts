/**
 * Erreichbarkeitspruefung der Datenbank fuer den oeffentlichen Health-Check (Phase 16a).
 * Eigene, injizierbare Funktion (Tests ersetzen sie), damit die Route selbst keine Details preisgibt.
 */
import { dbInternal } from "@/lib/db";

export const DB_CHECK_TIMEOUT_MS = 2000;

export async function checkDb(timeoutMs: number = DB_CHECK_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    await Promise.race([dbInternal.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
