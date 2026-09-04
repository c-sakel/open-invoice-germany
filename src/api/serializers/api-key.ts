import { iso } from "./common";
import type { ApiKeySummary } from "@/domain/api-key/list";

/** Nie Token/Hash (siehe listApiKeys) — nur Metadaten. */
export function serializeApiKey(k: ApiKeySummary) {
  return {
    objectName: "ApiKey" as const,
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    lastUsedAt: iso(k.lastUsedAt),
    expiresAt: iso(k.expiresAt),
    revokedAt: iso(k.revokedAt),
    createdAt: iso(k.createdAt),
  };
}
