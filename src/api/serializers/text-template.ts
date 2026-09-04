import { iso } from "./common";
import type { TextTemplate } from "@/generated/prisma/client";

export function serializeTextTemplate(t: TextTemplate) {
  return {
    objectName: "TextTemplate" as const,
    id: t.id,
    name: t.name,
    docType: t.docType,
    position: t.position,
    body: t.body,
    isDefault: t.isDefault,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}
