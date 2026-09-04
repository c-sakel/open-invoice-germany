import { iso } from "./common";
import type { DocumentAttachment } from "@/generated/prisma/client";

export function serializeAttachment(a: DocumentAttachment) {
  return {
    objectName: "Attachment" as const,
    id: a.id,
    docType: a.docType,
    docId: a.docId,
    filename: a.filename,
    mime: a.mime,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    uploadedBy: a.uploadedBy,
    createdAt: iso(a.createdAt),
  };
}
