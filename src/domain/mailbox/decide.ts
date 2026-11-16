/**
 * Entscheidungen ueber Postfach-Anlagen: uebernehmen (Annahme als Eingangsrechnung ins write-once-Archiv),
 * verwerfen und wiederherstellen. Das Archiv wird nur beim Uebernehmen beschrieben; Mails werden nie veraendert.
 * Jeder Statuswechsel ist an den erwarteten Vorzustand gebunden (updateMany mit Status), damit parallele
 * Entscheidungen genau einmal wirken.
 */
import { dbInternal } from "@/lib/db";
import { hashArchiveFile } from "@/lib/archive/storage";
import { NotFoundError } from "@/domain/errors";
import { createNotification } from "@/domain/notifications/create";
import { logActivity } from "@/domain/activity/log";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError } from "@/domain/incoming/errors";
import { receiveIncomingInvoice, type ReceiveResult } from "@/domain/incoming/receive";
import { inboundAcceptBatchSchema, inboundDiscardInputSchema } from "@/schemas/mailbox";
import { InboundMailError, StagingTamperedError } from "./errors";
import { getInboundAttachment, type InboundAttachmentRow } from "./list";
import { readStagingFile, removeStagingFile } from "./staging";

export { InboundMailError } from "./errors";

async function activity(orgId: string, id: string, type: "INBOUND_MAIL_ACCEPTED" | "INBOUND_MAIL_DISCARDED" | "INBOUND_MAIL_RESTORED", actor: string, at: Date, data: unknown): Promise<void> {
  await logActivity(dbInternal, { orgId, entityType: "INBOUND_MAIL", entityId: id, type, actor, at, data });
}

/** Entfernt die Kopie in der Zwischenablage, wenn keine andere offene oder verworfene Anlage sie braucht. */
async function releaseStaging(orgId: string, stagingPath: string): Promise<void> {
  const shared = await dbInternal.inboundMailAttachment.count({ where: { orgId, stagingPath, status: { in: ["INBOX", "DISCARDED"] } } });
  if (shared === 0) await removeStagingFile(stagingPath);
}

export async function acceptInboundAttachment(
  orgId: string,
  id: string,
  actor: string,
  now: Date = new Date(),
): Promise<{ incomingInvoiceId: string; result: ReceiveResult }> {
  const row =
    id.length <= 64
      ? await dbInternal.inboundMailAttachment.findFirst({
          where: { id, orgId },
          select: { id: true, status: true, fileName: true, sha256: true, stagingPath: true, message: { select: { internalDate: true, fetchedAt: true, senderDomain: true } } },
        })
      : null;
  if (!row) throw new NotFoundError("Anlage nicht gefunden.");
  if (row.status !== "INBOX") throw new InboundMailError("NOT_INBOX");
  if (row.stagingPath === null) throw new InboundMailError("STAGING_MISSING");
  const stagingPath = row.stagingPath;

  let bytes: Buffer;
  try {
    bytes = await readStagingFile(stagingPath, row.sha256);
  } catch (e) {
    if (e instanceof StagingTamperedError) throw new InboundMailError("STAGING_MISSING");
    throw e;
  }

  let result: ReceiveResult;
  try {
    result = await receiveIncomingInvoice(orgId, bytes, {
      channel: "MAILBOX",
      fileName: row.fileName,
      actor,
      now,
      source: { inboundAttachmentId: row.id, mailInternalDate: row.message.internalDate, fetchedAt: row.message.fetchedAt, senderDomain: row.message.senderDomain },
      withinTx: async (tx, incomingInvoiceId) => {
        const upd = await tx.inboundMailAttachment.updateMany({
          where: { id: row.id, orgId, status: "INBOX" },
          data: { status: "ACCEPTED", incomingInvoiceId, decidedAt: now, decidedBy: actor },
        });
        if (upd.count !== 1) throw new InboundMailError("CONFLICT");
      },
    });
  } catch (e) {
    if (e instanceof IncomingDuplicateError) {
      const upd = await dbInternal.inboundMailAttachment.updateMany({
        where: { id: row.id, orgId, status: "INBOX" },
        data: { status: "DUPLICATE", duplicateOfIncomingId: e.existingId, stagingPath: null },
      });
      if (upd.count === 1) await releaseStaging(orgId, stagingPath).catch(() => undefined);
      throw new InboundMailError("ALREADY_RECEIVED", { incomingInvoiceId: e.existingId });
    }
    // Formatfehler, ausgelastete Pruefung, Rate-Limit: die Anlage bleibt in der Zwischenablage.
    throw e;
  }

  // Die Kopie bleibt in der Zeile referenziert, bis die archivierte Datei nachweislich dieselben Bytes hat;
  // sonst bleibt sie als einzige Kopie liegen (der Aufraeum-Lauf entfernt nur nicht referenzierte Dateien).
  let confirmed = false;
  try {
    const inc = await dbInternal.incomingInvoice.findFirst({ where: { id: result.id, orgId }, select: { originalPath: true, originalSha256: true } });
    confirmed = inc !== null && (await hashArchiveFile(inc.originalPath)) === inc.originalSha256 && inc.originalSha256 === row.sha256;
  } catch {
    confirmed = false;
  }
  if (confirmed) {
    try {
      await dbInternal.inboundMailAttachment.updateMany({ where: { id: row.id, orgId, status: "ACCEPTED", stagingPath }, data: { stagingPath: null } });
      await releaseStaging(orgId, stagingPath);
    } catch {
      console.error("Postfach: Zwischenablage konnte nicht aufgeraeumt werden");
    }
  } else {
    console.error("Postfach: Archivdatei nicht bestaetigt, Kopie in der Zwischenablage bleibt liegen");
    await createNotification({
      orgId,
      type: "INBOUND_MAIL_ERROR",
      title: "Postfach: Die archivierte Datei konnte nicht bestaetigt werden. Die Kopie in der Zwischenablage bleibt erhalten.",
      link: "/eingang?quelle=postfach",
      entityType: "INBOUND_MAIL",
      dedupeKey: `ARCHIVE_UNCONFIRMED:${row.id}`,
      at: now,
    }).catch(() => undefined);
  }
  // Der Beleg ist angelegt: ein Fehler im Protokoll darf die Uebernahme nicht als gescheitert melden.
  await activity(orgId, row.id, "INBOUND_MAIL_ACCEPTED", actor, now, { incomingInvoiceId: result.id }).catch(() => console.error("Postfach: Aktivitaetsprotokoll nicht geschrieben"));
  return { incomingInvoiceId: result.id, result };
}

export type AcceptBatchEntry = { id: string; ok: boolean; code?: string; incomingInvoiceId?: string };

/** Mehrere Anlagen nacheinander uebernehmen (hoechstens 20); ein Fehler stoppt die uebrigen nicht. */
export async function acceptInboundAttachments(orgId: string, ids: string[], actor: string): Promise<AcceptBatchEntry[]> {
  const list = inboundAcceptBatchSchema.parse(ids);
  const out: AcceptBatchEntry[] = [];
  for (const id of list) {
    try {
      const r = await acceptInboundAttachment(orgId, id, actor);
      out.push({ id, ok: true, incomingInvoiceId: r.incomingInvoiceId });
    } catch (e) {
      if (e instanceof NotFoundError) out.push({ id, ok: false, code: "NOT_FOUND" });
      else if (e instanceof InboundMailError) out.push({ id, ok: false, code: e.code, ...(e.details?.incomingInvoiceId ? { incomingInvoiceId: e.details.incomingInvoiceId } : {}) });
      else if (e instanceof IncomingFormatError) out.push({ id, ok: false, code: e.code });
      else if (e instanceof IncomingBusyError) out.push({ id, ok: false, code: "BUSY" });
      else out.push({ id, ok: false, code: "ERROR" });
    }
  }
  return out;
}

export async function discardInboundAttachment(orgId: string, id: string, raw: unknown, actor: string, now: Date = new Date()): Promise<InboundAttachmentRow> {
  const input = inboundDiscardInputSchema.parse(raw ?? {});
  const current = await getInboundAttachment(orgId, id);
  if (current.status !== "INBOX") throw new InboundMailError("NOT_INBOX");
  const reason = input.reason && input.reason.length > 0 ? input.reason : null;
  const upd = await dbInternal.inboundMailAttachment.updateMany({
    where: { id, orgId, status: "INBOX" },
    data: { status: "DISCARDED", decidedAt: now, decidedBy: actor, discardReason: reason },
  });
  if (upd.count !== 1) throw new InboundMailError("CONFLICT");
  await activity(orgId, id, "INBOUND_MAIL_DISCARDED", actor, now, { reasonLength: reason?.length ?? 0 });
  return getInboundAttachment(orgId, id);
}

export async function restoreInboundAttachment(orgId: string, id: string, actor: string, now: Date = new Date()): Promise<InboundAttachmentRow> {
  const current = await getInboundAttachment(orgId, id);
  if (current.status !== "DISCARDED") throw new InboundMailError("NOT_INBOX");
  if (current.purgedAt !== null) throw new InboundMailError("PURGED");
  const upd = await dbInternal.inboundMailAttachment.updateMany({
    where: { id, orgId, status: "DISCARDED", purgedAt: null },
    data: { status: "INBOX", decidedAt: null, decidedBy: null, discardReason: null },
  });
  if (upd.count !== 1) throw new InboundMailError("CONFLICT");
  await activity(orgId, id, "INBOUND_MAIL_RESTORED", actor, now, {});
  return getInboundAttachment(orgId, id);
}
