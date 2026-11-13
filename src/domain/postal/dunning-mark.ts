/**
 * Phase 16d — Versandvermerk der Mahnung beim Postversand (LIVE).
 *
 * `Dunning.sentAt` ist nie NULL (Vorbelegung bei der Erstellung). Der Postversand ueberschreibt ihn deshalb nur,
 * solange die Mahnung noch nicht versendet wurde (kein ChangeLog DUNNING_SEND zur Mahnung, z. B. per E-Mail).
 * Den vorherigen Wert und den gesetzten Zeitpunkt haelt das Ereignis `DUNNING_SENT` am Postauftrag fest; ein
 * Storno (oder externes Storno) setzt `sentAt` nur zurueck, wenn der Wert noch von diesem Auftrag stammt,
 * und schreibt ein Gegen-Ereignis (ChangeLog `DUNNING_SEND_REVERTED`).
 */
import type { Prisma } from "@/generated/prisma/client";
import { appendChangeLog } from "@/domain/audit";
import { addPostalEvent } from "./events";

interface MarkInput {
  orgId: string;
  jobId: string;
  invoiceId: string;
  dunningId: string;
  docNumber: string;
  at: Date;
  actor: string;
}

/** Vermerkt den Postversand der Mahnung (ChangeLog DUNNING_SEND) und setzt `sentAt`, wenn noch nicht versendet. */
export async function markDunningSentByPost(tx: Prisma.TransactionClient, i: MarkInput): Promise<void> {
  const earlier = await tx.changeLog.findFirst({
    where: { orgId: i.orgId, entity: "INVOICE", entityId: i.invoiceId, action: "DUNNING_SEND", diffJson: { contains: i.dunningId } },
    select: { id: true },
  });
  if (!earlier) {
    const before = await tx.dunning.findUniqueOrThrow({ where: { id: i.dunningId }, select: { sentAt: true } });
    await tx.dunning.update({ where: { id: i.dunningId }, data: { sentAt: i.at }, select: { id: true } });
    await addPostalEvent(tx, {
      jobId: i.jobId,
      orgId: i.orgId,
      kind: "DUNNING_SENT",
      status: "QUEUED",
      data: { sentAtBefore: before.sentAt.toISOString(), sentAt: i.at.toISOString() },
      at: i.at,
    });
  }
  await appendChangeLog(tx, {
    orgId: i.orgId,
    entity: "INVOICE",
    entityId: i.invoiceId,
    action: "DUNNING_SEND",
    actor: i.actor,
    at: i.at,
    diff: { dunningId: i.dunningId, number: i.docNumber, channel: "POST" },
  });
}

interface RevertJob {
  id: string;
  orgId: string;
  invoiceId: string;
  docType: string;
  docId: string;
  docNumber: string;
  mode: string;
}

/** Storno eines LIVE-Mahnungs-Postauftrags: `sentAt` zuruecksetzen, aber nur wenn der Wert von diesem Auftrag stammt. */
export async function revertDunningSentByPost(tx: Prisma.TransactionClient, job: RevertJob, at: Date, actor: string): Promise<void> {
  if (job.docType !== "DUNNING" || job.mode !== "LIVE") return;
  const ev = await tx.postalJobEvent.findFirst({ where: { jobId: job.id, kind: "DUNNING_SENT" }, select: { dataJson: true } });
  if (!ev) return;
  let before: Date;
  let marked: Date;
  try {
    const d = JSON.parse(ev.dataJson) as { sentAtBefore?: string; sentAt?: string };
    before = new Date(d.sentAtBefore ?? "");
    marked = new Date(d.sentAt ?? "");
  } catch {
    return;
  }
  if (Number.isNaN(before.getTime()) || Number.isNaN(marked.getTime())) return;
  const dun = await tx.dunning.findUnique({ where: { id: job.docId }, select: { sentAt: true } });
  if (!dun || dun.sentAt.getTime() !== marked.getTime()) return;
  await tx.dunning.update({ where: { id: job.docId }, data: { sentAt: before }, select: { id: true } });
  await addPostalEvent(tx, {
    jobId: job.id,
    orgId: job.orgId,
    kind: "DUNNING_REVERTED",
    status: "CANCELLED",
    data: { sentAt: before.toISOString() },
    at,
  });
  await appendChangeLog(tx, {
    orgId: job.orgId,
    entity: "INVOICE",
    entityId: job.invoiceId,
    action: "DUNNING_SEND_REVERTED",
    actor,
    at,
    diff: { dunningId: job.docId, number: job.docNumber, channel: "POST", reason: "Postauftrag storniert" },
  });
}
