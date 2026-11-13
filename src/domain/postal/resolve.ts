/**
 * Phase 16d — Manueller Abschluss eines UNKNOWN-Postauftrags durch den Betreiber.
 *
 * Der Abgleich findet manche Auftraege nie (Anbieterliste zu lang, Brief nicht auffindbar). Der Betreiber
 * entscheidet dann nach Pruefung beim Briefdienst: "SENT" (Brief wurde versendet -> DONE) oder "NOT_SENT"
 * (nichts versendet -> FAILED, ein erneuter Versand ist wieder moeglich). Der Statuswechsel laeuft nur ueber
 * `transitionPostalJob` (UNKNOWN als einziger Vorgaenger), mit Ereignis und ChangeLog; Org-Scope immer.
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { emitEvent } from "@/domain/webhook/emit";
import { serializePostalJob } from "@/api/serializers/postal";
import { NotFoundError } from "@/domain/errors";
import { PostalConflictError } from "./errors";
import { addPostalEvent, POSTAL_JOB_SELECT, transitionPostalJob } from "./events";
import { markDunningSentByPost } from "./dunning-mark";

export const resolveUnknownInputSchema = z.object({
  outcome: z.enum(["SENT", "NOT_SENT"]),
  note: z.string().trim().min(3, "Bitte eine Begruendung angeben.").max(500),
});

export async function resolveUnknownPostalJob(
  orgId: string,
  jobId: string,
  outcome: "SENT" | "NOT_SENT",
  note: string,
  ctx: { actor: string; now?: Date } = { actor: "system" },
): Promise<{ status: "DONE" | "FAILED" }> {
  const input = resolveUnknownInputSchema.parse({ outcome, note });
  const at = ctx.now ?? new Date();
  const job = await dbInternal.postalJob.findFirst({
    where: { id: jobId, orgId },
    select: { id: true, docType: true, docId: true, invoiceId: true, docNumber: true, mode: true, status: true },
  });
  if (!job) throw new NotFoundError("Postauftrag nicht gefunden.");
  if (job.status !== "UNKNOWN") throw new PostalConflictError("Nur Auftraege mit unklarem Ausgang koennen manuell abgeschlossen werden.", "NOT_ALLOWED");

  const sent = input.outcome === "SENT";
  const target = sent ? "DONE" : "FAILED";
  await dbInternal.$transaction(async (tx) => {
    const moved = await transitionPostalJob(
      tx,
      job.id,
      target,
      sent ? { finishedAt: at, error: null } : { finishedAt: at, error: `Vom Betreiber als nicht versendet bestaetigt: ${input.note}` },
    );
    if (!moved) throw new PostalConflictError("Der Postauftrag wurde inzwischen veraendert.", "NOT_ALLOWED");
    await addPostalEvent(tx, {
      jobId: job.id,
      orgId,
      kind: "RESOLVED",
      status: target,
      data: { outcome: input.outcome, note: input.note, by: ctx.actor, from: "UNKNOWN" },
      at,
    });
    if (sent && job.mode === "LIVE" && job.docType === "DUNNING") {
      await markDunningSentByPost(tx, {
        orgId,
        jobId: job.id,
        invoiceId: job.invoiceId,
        dunningId: job.docId,
        docNumber: job.docNumber,
        at,
        actor: ctx.actor,
        status: target,
      });
    }
    const row = await tx.postalJob.findUniqueOrThrow({ where: { id: job.id }, select: POSTAL_JOB_SELECT });
    await appendChangeLog(tx, {
      orgId,
      entity: "POSTAL",
      entityId: job.id,
      action: sent ? "RESOLVED_SENT" : "RESOLVED_NOT_SENT",
      actor: ctx.actor,
      at,
      diff: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, mode: job.mode, outcome: input.outcome, note: input.note },
    });
    await logActivity(tx, {
      orgId,
      entityType: "INVOICE",
      entityId: job.invoiceId,
      type: sent ? "POSTAL_SENT" : "POSTAL_FAILED",
      actor: ctx.actor,
      at,
      data: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, jobId: job.id, resolved: true },
    });
    await emitEvent(tx, { orgId, type: sent ? "postal.done" : "postal.failed", objectName: "PostalJob", objectId: job.id, data: serializePostalJob(row), now: at });
  });
  return { status: target };
}
