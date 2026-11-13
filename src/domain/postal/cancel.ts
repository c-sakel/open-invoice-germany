/**
 * Phase 16d — Storno eines Postauftrags beim Briefdienst.
 *
 * Nur binnen 15 Minuten nach der Uebertragung und nur in den Zustaenden QUEUED, HOLD oder DRAFT
 * (Doku: DELETE binnen 15 min und nie bei `done`). Trockenlaeufe, laufende, unklare und
 * abgeschlossene Auftraege sind nicht stornierbar. Der Netzaufruf liegt ausserhalb der Transaktion;
 * der Statuswechsel laeuft per bedingtem updateMany (kein Doppel-Storno).
 */
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { emitEvent } from "@/domain/webhook/emit";
import { serializePostalJob } from "@/api/serializers/postal";
import { NotFoundError } from "@/domain/errors";
import { createLetterXpressClient, LxpRequestError, redact } from "@/lib/postal/letterxpress";
import { defaultTransport, type LxpTransport } from "@/lib/postal/transport";
import { PostalConflictError } from "./errors";
import { addPostalEvent, CANCEL_WINDOW_MS, POSTAL_JOB_SELECT, transitionPostalJob } from "./events";
import { revertDunningSentByPost } from "./dunning-mark";
import { loadPostalCredentials, PostalKeyUnreadableError } from "./settings";

const CANCELLABLE = ["QUEUED", "HOLD", "DRAFT"];

export async function cancelPostalJob(
  orgId: string,
  jobId: string,
  ctx: { actor: string; transport?: LxpTransport; now?: Date },
): Promise<{ status: "CANCELLED" }> {
  const now = ctx.now ?? new Date();
  const job = await dbInternal.postalJob.findFirst({
    where: { id: jobId, orgId },
    select: { id: true, docType: true, docId: true, invoiceId: true, docNumber: true, mode: true, status: true, providerJobId: true, submittedAt: true },
  });
  if (!job) throw new NotFoundError("Postauftrag nicht gefunden.");
  if (job.mode === "DRY_RUN" || !CANCELLABLE.includes(job.status) || job.providerJobId === null || !job.submittedAt) {
    throw new PostalConflictError("Dieser Postauftrag kann nicht storniert werden.", "NOT_CANCELLABLE");
  }
  if (now.getTime() - job.submittedAt.getTime() > CANCEL_WINDOW_MS) {
    throw new PostalConflictError("Die Stornofrist von 15 Minuten ist abgelaufen.", "NOT_CANCELLABLE");
  }

  let creds;
  try {
    creds = await loadPostalCredentials(orgId);
  } catch (e) {
    if (e instanceof PostalKeyUnreadableError) throw new PostalConflictError(e.message, "NOT_CANCELLABLE");
    throw e;
  }
  if (!creds) throw new PostalConflictError("Postversand ist nicht eingerichtet (Zugangsdaten fehlen).", "NOT_CANCELLABLE");
  const client = createLetterXpressClient({ ...creds, mode: job.mode === "LIVE" ? "live" : "test" }, ctx.transport ?? defaultTransport());

  try {
    await client.remove(job.providerJobId);
  } catch (e) {
    // Abgelehnt (z. B. bereits verarbeitet): endgueltig nicht stornierbar. Auth/Ausfall: Fehler weiterreichen.
    if (e instanceof LxpRequestError) throw new PostalConflictError(redact(e.message, creds), "NOT_CANCELLABLE");
    throw e;
  }

  await dbInternal.$transaction(async (tx) => {
    if (!(await transitionPostalJob(tx, job.id, "CANCELLED", { finishedAt: now }))) {
      throw new PostalConflictError("Der Postauftrag wurde inzwischen veraendert.", "NOT_CANCELLABLE");
    }
    await addPostalEvent(tx, { jobId: job.id, orgId, kind: "CANCELLED", status: "CANCELLED", data: { by: ctx.actor }, at: now });
    await revertDunningSentByPost(tx, { ...job, orgId }, now, ctx.actor);
    const row = await tx.postalJob.findUniqueOrThrow({ where: { id: job.id }, select: POSTAL_JOB_SELECT });
    await appendChangeLog(tx, {
      orgId,
      entity: "POSTAL",
      entityId: job.id,
      action: "CANCELLED",
      actor: ctx.actor,
      at: now,
      diff: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, providerJobId: job.providerJobId, mode: job.mode },
    });
    await logActivity(tx, {
      orgId,
      entityType: "INVOICE",
      entityId: job.invoiceId,
      type: "POSTAL_CANCELLED",
      actor: ctx.actor,
      at: now,
      data: { docType: job.docType, docId: job.docId, jobId: job.id },
    });
    await emitEvent(tx, { orgId, type: "postal.cancelled", objectName: "PostalJob", objectId: job.id, data: serializePostalJob(row), now });
  });
  return { status: "CANCELLED" };
}
