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

/** Ergebnis-Cache fuer den oeffentlichen Health-Check (Ruling 16a): DB hoechstens alle 5 s gefragt. */
export const HEALTH_CACHE_TTL_MS = 5000;

let cached: { ok: boolean; at: number } | null = null;
let inflight: Promise<boolean> | null = null;

/**
 * DB-Status mit 5-s-Cache; gleichzeitige Aufrufer teilen sich eine laufende Abfrage.
 * Ersetzt ein Rate-Limit, damit der Docker-Healthcheck nie ausgesperrt wird.
 */
export async function cachedDbStatus(now: number = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < HEALTH_CACHE_TTL_MS) return cached.ok;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ok = await checkDb();
      cached = { ok, at: Date.now() };
      return ok;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Nur fuer Tests. */
export function resetHealthCache(): void {
  cached = null;
  inflight = null;
}
