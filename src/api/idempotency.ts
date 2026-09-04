/**
 * Idempotenz fuer schreibende /api/v1/*-Aktionen (Phase 10, Task 1, task-1-facts.md):
 * Header `Idempotency-Key` (nur POST, 1..128 Zeichen). requestHash = sha256(method+
 * path+body). Wiederholung mit demselben Hash liefert die gespeicherte Antwort;
 * abweichender Hash -> 409 IDEMPOTENCY_MISMATCH. Ablauf 24h, Aufraeumen lazy beim
 * naechsten Lesen desselben Schluessels (kein eigener Scheduler-Job).
 *
 * Nur Antworten mit Status < 500 werden gespeichert — ein 5xx darf bei einem Retry
 * mit demselben Idempotency-Key erneut versucht werden (transiente Fehler), waehrend
 * eine deterministische 2xx/4xx-Antwort (z. B. "bereits festgeschrieben") bewusst
 * repliziert wird, damit Netzwerk-Retries nicht doppelt buchen (GoBD).
 */
import { createHash } from "node:crypto";
import { dbInternal } from "@/lib/db";

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentReplay {
  status: number;
  body: unknown;
}

export function hashIdempotentRequest(method: string, path: string, rawBody: string): string {
  return createHash("sha256").update(`${method}\n${path}\n${rawBody}`, "utf8").digest("hex");
}

/**
 * Prueft, ob unter `key` bereits eine gueltige Antwort gespeichert ist. Liefert sie
 * bei identischem Request zurueck, wirft IdempotencyConflictError bei abweichendem
 * Request, oder liefert `null` (kein/abgelaufener Eintrag -> Handler laeuft normal).
 */
export async function checkIdempotency(orgId: string, key: string, method: string, path: string, rawBody: string): Promise<IdempotentReplay | null> {
  const requestHash = hashIdempotentRequest(method, path, rawBody);
  const existing = await dbInternal.apiIdempotency.findUnique({ where: { orgId_key: { orgId, key } } });
  if (!existing) return null;

  if (Date.now() - existing.createdAt.getTime() > TTL_MS) {
    // Abgelaufen: lazy loeschen, Aufrufer faehrt wie ohne Eintrag fort.
    await dbInternal.apiIdempotency.delete({ where: { orgId_key: { orgId, key } } }).catch(() => {});
    return null;
  }

  if (existing.requestHash !== requestHash) {
    throw new IdempotencyConflictError(`Idempotency-Key "${key}" wurde bereits mit einem abweichenden Request verwendet.`);
  }

  return { status: existing.statusCode, body: JSON.parse(existing.responseJson) as unknown };
}

/** Speichert die Antwort unter `key` (upsert — ein zweiter, identischer Request ueberschreibt mit demselben Inhalt). */
export async function storeIdempotentResponse(orgId: string, key: string, method: string, path: string, rawBody: string, status: number, body: unknown): Promise<void> {
  const requestHash = hashIdempotentRequest(method, path, rawBody);
  const responseJson = JSON.stringify(body ?? null);
  await dbInternal.apiIdempotency.upsert({
    where: { orgId_key: { orgId, key } },
    create: { orgId, key, requestHash, statusCode: status, responseJson },
    update: { requestHash, statusCode: status, responseJson },
  });
}
