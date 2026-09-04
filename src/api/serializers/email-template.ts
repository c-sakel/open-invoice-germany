import { iso } from "./common";
import type { EmailTemplate } from "@/generated/prisma/client";

export function serializeEmailTemplate(t: EmailTemplate) {
  return {
    objectName: "EmailTemplate" as const,
    id: t.id,
    name: t.name,
    docType: t.docType,
    subject: t.subject,
    body: t.body,
    signature: t.signature,
    isDefault: t.isDefault,
    isSystem: t.isSystem,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}
