/**
 * Pruefung der GoBD-Hash-Kette (ChangeLog) im Betrieb (Phase 16a). Liest je Organisation
 * seitenweise (Cursor ueber `id`, Bloecke zu 1000), damit grosse Ketten den Speicher nicht
 * sprengen; der Vorgaengerhash wird ueber Blockgrenzen fortgeschrieben. Hash-Logik ist die
 * bestehende aus `@/domain/changelog` (`computeEntryHash`), die Payload-Bildung spiegelt
 * `appendChangeLog`. Jede Pruefung wird als `ChainVerification` protokolliert; bei Bruch
 * geht der Pflicht-Alarm CHAIN_BROKEN raus.
 */
import { dbInternal } from "@/lib/db";
import { computeEntryHash, type ChangeLogPayload } from "@/domain/changelog";
import { onChainBroken } from "@/domain/notifications/hooks";

export const CHAIN_VERIFY_BLOCK = 1000;
export const AUDIT_JOB_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type ChainVerificationTrigger = "UI" | "API" | "MCP" | "SCHEDULER" | "CLI";

export interface ChainVerificationResult {
  valid: boolean;
  entries: number;
  brokenEntryId: number | null;
  lastHash: string;
  durationMs: number;
  checkedAt: Date;
}

type Db = typeof dbInternal;

/** `ok: false` bei unlesbarem Diff-Text — gilt sofort als Bruch (nie als `null` weiterhashen). */
function parseDiff(diffJson: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(diffJson) };
  } catch {
    return { ok: false };
  }
}

export async function verifyOrgChain(
  orgId: string,
  trigger: ChainVerificationTrigger,
  db: Db = dbInternal,
): Promise<ChainVerificationResult> {
  const started = Date.now();
  let prev = "";
  let entries = 0;
  let brokenEntryId: number | null = null;
  let cursor = 0;
  let lastId = 0;

  // Endabschneiden erkennen: Stand der letzten gueltigen Pruefung (Anzahl + Hash an dieser Position).
  const anchor = await db.chainVerification.findFirst({
    where: { orgId, valid: true },
    orderBy: { checkedAt: "desc" },
    select: { entries: true, lastHash: true },
  });

  outer: for (;;) {
    const block = await db.changeLog.findMany({
      where: { orgId, id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: CHAIN_VERIFY_BLOCK,
      select: { id: true, entity: true, entityId: true, action: true, actor: true, at: true, diffJson: true, prevHash: true, hash: true },
    });
    if (block.length === 0) break;
    for (const row of block) {
      const diff = parseDiff(row.diffJson);
      if (!diff.ok) {
        brokenEntryId = row.id;
        break outer;
      }
      const payload: ChangeLogPayload = {
        entity: row.entity,
        entityId: row.entityId,
        action: row.action,
        actor: row.actor,
        at: row.at.toISOString(),
        diff: diff.value,
      };
      if (row.prevHash !== prev || computeEntryHash(prev, payload) !== row.hash) {
        brokenEntryId = row.id;
        break outer;
      }
      prev = row.hash;
      entries++;
      lastId = row.id;
      if (anchor && anchor.entries > 0 && entries === anchor.entries && row.hash !== anchor.lastHash) {
        entries--;
        brokenEntryId = row.id;
        break outer;
      }
    }
    cursor = block[block.length - 1].id;
    if (block.length < CHAIN_VERIFY_BLOCK) break;
  }

  // Weniger Eintraege als bei der letzten gueltigen Pruefung: Kettenende wurde abgeschnitten.
  if (brokenEntryId === null && anchor && entries < anchor.entries) brokenEntryId = lastId;

  const checkedAt = new Date();
  const result: ChainVerificationResult = {
    valid: brokenEntryId === null,
    entries,
    brokenEntryId,
    lastHash: prev,
    durationMs: Date.now() - started,
    checkedAt,
  };
  await db.chainVerification.create({
    data: {
      orgId,
      checkedAt,
      valid: result.valid,
      entries,
      brokenEntryId,
      lastHash: prev,
      durationMs: result.durationMs,
      trigger,
    },
  });
  if (brokenEntryId !== null) await onChainBroken(orgId, { brokenEntryId, at: checkedAt });
  return result;
}

/** Scheduler-Job `audit`: je Organisation nur, wenn die letzte Pruefung aelter als 7 Tage ist. Seriell. */
export async function runAuditJob(now: Date, db: Db = dbInternal): Promise<{ checked: number }> {
  const orgs = await db.organization.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const threshold = new Date(now.getTime() - AUDIT_JOB_INTERVAL_MS);
  let checked = 0;
  for (const org of orgs) {
    const last = await db.chainVerification.findFirst({
      where: { orgId: org.id },
      orderBy: { checkedAt: "desc" },
      select: { checkedAt: true },
    });
    if (last && last.checkedAt > threshold) continue;
    try {
      await verifyOrgChain(org.id, "SCHEDULER", db);
      checked++;
    } catch (e) {
      console.error("audit-job: Kettenpruefung fehlgeschlagen", org.id, e instanceof Error ? e.message : e);
    }
  }
  return { checked };
}

export async function listChainVerifications(orgId: string, limit: number) {
  return dbInternal.chainVerification.findMany({
    where: { orgId },
    orderBy: { checkedAt: "desc" },
    take: limit,
    select: { id: true, checkedAt: true, valid: true, entries: true, brokenEntryId: true, lastHash: true, durationMs: true, trigger: true },
  });
}
