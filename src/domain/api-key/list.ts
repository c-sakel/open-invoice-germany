/** Auflistung der API-Schluessel einer Organisation (Phase 10, Task 1) — ohne Token/Hash. */
import { dbInternal } from "@/lib/db";
import type { ApiKeyScope } from "@/schemas";

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export async function listApiKeys(orgId: string): Promise<ApiKeySummary[]> {
  const rows = await dbInternal.apiKey.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopesJson.split(",").filter(Boolean) as ApiKeyScope[],
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  }));
}
