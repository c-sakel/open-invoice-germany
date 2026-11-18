/**
 * Sperre je Bankzugang: hoechstens ein Dialog gleichzeitig (auch ueber Prozesse hinweg). Die Sperre laeuft nach
 * FETCH_LEASE_MS von selbst ab; ein haengender Vorgang blockiert den Zugang also nie dauerhaft.
 */
import { dbInternal } from "@/lib/db";
import { FETCH_LEASE_MS } from "./limits";

/** true, wenn die Sperre erworben wurde. Archivierte Bankzugaenge lassen sich nie sperren. */
export async function acquireLease(orgId: string, connectionId: string, now: Date): Promise<boolean> {
  const res = await dbInternal.bankConnection.updateMany({
    where: {
      id: connectionId,
      orgId,
      archivedAt: null,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: new Date(now.getTime() + FETCH_LEASE_MS), lastAttemptAt: now },
  });
  return res.count === 1;
}

export async function releaseLease(orgId: string, connectionId: string): Promise<void> {
  try {
    await dbInternal.bankConnection.updateMany({ where: { id: connectionId, orgId }, data: { leaseUntil: null } });
  } catch {
    // die Sperre laeuft ohnehin ab
  }
}
