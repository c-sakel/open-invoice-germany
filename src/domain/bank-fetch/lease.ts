/**
 * Sperre je Bankzugang: hoechstens ein Dialog gleichzeitig (auch ueber Prozesse hinweg). Die Sperre laeuft nach
 * FETCH_LEASE_MS von selbst ab; ein haengender Vorgang blockiert den Zugang also nie dauerhaft.
 */
import { dbInternal } from "@/lib/db";
import { FETCH_LEASE_MS } from "./limits";

/**
 * Die Sperre gehoert ihrem Besitzer: der Besitzer ist durch das Ablaufdatum gekennzeichnet, das beim Erwerb gesetzt wurde.
 * Freigeben kann nur, wer dieses Datum noch kennt; eine inzwischen neu erworbene Sperre eines anderen bleibt bestehen.
 */
export type Lease = Date;

/** Das Ablaufdatum der erworbenen Sperre (Besitzerkennung) oder null. Archivierte Bankzugaenge lassen sich nie sperren. */
export async function acquireLease(orgId: string, connectionId: string, now: Date): Promise<Lease | null> {
  const until = new Date(now.getTime() + FETCH_LEASE_MS);
  const res = await dbInternal.bankConnection.updateMany({
    where: {
      id: connectionId,
      orgId,
      archivedAt: null,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: until, lastAttemptAt: now },
  });
  return res.count === 1 ? until : null;
}

/** Gibt nur die eigene Sperre frei (gleiche Besitzerkennung). */
export async function releaseLease(orgId: string, connectionId: string, lease: Lease): Promise<void> {
  try {
    await dbInternal.bankConnection.updateMany({ where: { id: connectionId, orgId, leaseUntil: lease }, data: { leaseUntil: null } });
  } catch {
    // die Sperre laeuft ohnehin ab
  }
}
