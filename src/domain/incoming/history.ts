/**
 * Verlauf einer Eingangsrechnung aus dem Aenderungsprotokoll. Die Zusammenfassung enthaelt nur
 * Status, Aktion, Grund, Zahltag und die Namen geaenderter Felder, nie Notiztexte.
 */
import { dbInternal } from "@/lib/db";

export interface IncomingHistoryEntry {
  at: Date;
  action: string;
  actor: string;
  summary: Record<string, unknown>;
}

const PICK = ["from", "to", "action", "reason", "paidOn"] as const;
const MAX_HISTORY = 100;

function summarize(action: string, diffJson: string): Record<string, unknown> {
  let diff: unknown;
  try {
    diff = JSON.parse(diffJson);
  } catch {
    return {};
  }
  if (typeof diff !== "object" || diff === null || Array.isArray(diff)) return {};
  const d = diff as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PICK) if (typeof d[k] === "string") out[k] = d[k];
  if (action === "UPDATE") out.changedKeys = Object.keys(d).sort();
  return out;
}

export async function incomingHistory(orgId: string, id: string): Promise<IncomingHistoryEntry[]> {
  const rows = await dbInternal.changeLog.findMany({
    where: { orgId, entity: "INCOMING_INVOICE", entityId: id },
    orderBy: { id: "desc" },
    take: MAX_HISTORY,
    select: { at: true, action: true, actor: true, diffJson: true },
  });
  return rows.map((r) => ({ at: r.at, action: r.action, actor: r.actor, summary: summarize(r.action, r.diffJson) }));
}
