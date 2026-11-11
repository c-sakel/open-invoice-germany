/**
 * Erreichbarkeitspruefung der Datenbank fuer den oeffentlichen Health-Check (Phase 16a).
 * Eigene, injizierbare Funktion (Tests ersetzen sie), damit die Route selbst keine Details preisgibt.
 */
import { dbInternal } from "@/lib/db";

export async function checkDb(): Promise<boolean> {
  try {
    await dbInternal.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
