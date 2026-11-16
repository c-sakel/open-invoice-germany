/**
 * Lesende Abfragen der Postfach-Anlagen fuer REST, MCP und Oberflaeche. Alles ist auf die Organisation begrenzt;
 * der Pfad der Zwischenablage verlaesst nie diese Schicht.
 */
import { dbInternal } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NotFoundError } from "@/domain/errors";
import { nextSyncCursor, resolveSyncWindow, syncWhere, SYNC_ORDER_BY } from "@/domain/sync/updated-since";
import { inboundAttachmentListQuerySchema } from "@/schemas/mailbox";
import { InboundMailError } from "./errors";
import { readStagingFile } from "./staging";

const ROW_SELECT = {
  id: true,
  status: true,
  fileName: true,
  mime: true,
  size: true,
  sha256: true,
  previewJson: true,
  incomingInvoiceId: true,
  duplicateOfIncomingId: true,
  duplicateOfAttachmentId: true,
  decidedAt: true,
  decidedBy: true,
  discardReason: true,
  purgedAt: true,
  skipReason: true,
  createdAt: true,
  updatedAt: true,
  message: { select: { internalDate: true, fetchedAt: true, senderDomain: true, subject: true } },
} as const;

export interface InboundAttachmentRow {
  id: string;
  status: string;
  fileName: string;
  mime: string;
  size: number;
  sha256: string;
  preview: unknown;
  receivedByMail: { internalDate: Date | null; fetchedAt: Date; senderDomain: string | null; subject: string | null };
  incomingInvoiceId: string | null;
  duplicateOfIncomingId: string | null;
  duplicateOfAttachmentId: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  discardReason: string | null;
  purgedAt: Date | null;
  skipReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type RawRow = Prisma.InboundMailAttachmentGetPayload<{ select: typeof ROW_SELECT }>;

function parsePreview(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export function toInboundAttachmentRow(r: RawRow): InboundAttachmentRow {
  const { message, previewJson, ...rest } = r;
  return { ...rest, preview: parsePreview(previewJson), receivedByMail: message };
}

export async function getInboundAttachment(orgId: string, id: string): Promise<InboundAttachmentRow> {
  const row = id.length <= 64 ? await dbInternal.inboundMailAttachment.findFirst({ where: { id, orgId }, select: ROW_SELECT }) : null;
  if (!row) throw new NotFoundError("Anlage nicht gefunden.");
  return toInboundAttachmentRow(row);
}

export async function listInboundAttachments(orgId: string, raw: unknown): Promise<{ items: InboundAttachmentRow[]; nextCursor: string | null }> {
  const q = inboundAttachmentListQuerySchema.parse(raw);
  const window = resolveSyncWindow(raw, { ...q, offset: 0 });
  const rows = await dbInternal.inboundMailAttachment.findMany({
    where: { orgId, ...(q.status ? { status: q.status } : {}), ...(window ? syncWhere(window) : {}) },
    orderBy: window ? [...SYNC_ORDER_BY] : [{ createdAt: "desc" }, { id: "asc" }],
    take: q.limit,
    select: ROW_SELECT,
  });
  return { items: rows.map(toInboundAttachmentRow), nextCursor: window ? nextSyncCursor(rows, q.limit) : null };
}

/** Datei einer offenen oder verworfenen Anlage aus der Zwischenablage (Hash geprueft). */
export async function getStagedFile(orgId: string, id: string): Promise<{ bytes: Buffer; fileName: string; mime: string }> {
  const row =
    id.length <= 64
      ? await dbInternal.inboundMailAttachment.findFirst({
          where: { id, orgId, status: { in: ["INBOX", "DISCARDED"] }, stagingPath: { not: null } },
          select: { stagingPath: true, sha256: true, fileName: true, mime: true },
        })
      : null;
  if (!row || row.stagingPath === null) throw new NotFoundError("Anlage nicht gefunden.");
  try {
    return { bytes: await readStagingFile(row.stagingPath, row.sha256), fileName: row.fileName, mime: row.mime };
  } catch {
    throw new InboundMailError("STAGING_MISSING");
  }
}
