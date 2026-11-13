/**
 * Phase 16d — Lesen der Postauftraege (REST/MCP). Immer mit orgId; fremde IDs sind "nicht gefunden".
 */
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { postalJobListFilterSchema } from "@/schemas/postal";
import { ACTIVE_POSTAL_STATUSES, POSTAL_JOB_SELECT } from "./events";

export async function listPostalJobs(orgId: string, rawFilter: unknown) {
  const f = postalJobListFilterSchema.parse(rawFilter);
  const where = {
    orgId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.docType ? { docType: f.docType } : {}),
    ...(f.docId ? { docId: f.docId } : {}),
    ...(f.mode ? { mode: f.mode } : {}),
  };
  const [total, rows] = await Promise.all([
    dbInternal.postalJob.count({ where }),
    dbInternal.postalJob.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: f.offset, take: f.limit, select: POSTAL_JOB_SELECT }),
  ]);
  return { rows, total, limit: f.limit, offset: f.offset };
}

export async function getPostalJob(orgId: string, id: string) {
  const job = await dbInternal.postalJob.findFirst({ where: { id, orgId }, select: POSTAL_JOB_SELECT });
  if (!job) throw new NotFoundError("Postauftrag nicht gefunden.");
  const events = await dbInternal.postalJobEvent.findMany({
    where: { jobId: job.id, orgId },
    orderBy: [{ at: "asc" }, { id: "asc" }],
    select: { id: true, jobId: true, orgId: true, at: true, kind: true, status: true, dataJson: true },
  });
  return { job, events };
}

/** Aktiver (nicht abgeschlossener/stornierter) Auftrag eines Belegs ausser Trockenlaeufen; fuer Hinweise in der Oberflaeche. */
export async function findActivePostalJob(orgId: string, docType: "INVOICE" | "DUNNING", docId: string) {
  return dbInternal.postalJob.findFirst({
    where: { orgId, docType, docId, mode: { not: "DRY_RUN" }, status: { in: [...ACTIVE_POSTAL_STATUSES] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, mode: true, status: true, submittedAt: true },
  });
}
