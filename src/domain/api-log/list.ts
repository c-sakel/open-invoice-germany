/**
 * Liest Eintraege des Anfrageprotokolls (Phase 12d, Task 2) — Listenfilter + Einzelabruf.
 * Nach dem Vorbild von src/domain/email/log-list.ts (dort `prisma`); hier ueber
 * `dbInternal`, wie die uebrigen Funktionen dieses Domains (`settings.ts`, `write.ts`,
 * `purge.ts`) — der GoBD-Guard in src/lib/db.ts betrifft ApiRequestLog ohnehin nicht.
 * `path`-Filter nutzt den portablen `ciContains`-Helfer aus src/lib/db.ts statt eines
 * rohen `{ contains }`, damit die Suche auf SQLite UND Postgres gleich funktioniert.
 */
import { ciContains, dbInternal } from "@/lib/db";
import { apiRequestLogFilterSchema } from "@/schemas/api-log";
import type { ApiRequestLog } from "@/generated/prisma/client";

export interface ApiRequestLogListResult {
  rows: ApiRequestLog[];
  total: number;
  limit: number;
  offset: number;
}

export async function listApiRequestLogs(orgId: string, rawFilter: unknown): Promise<ApiRequestLogListResult> {
  const filter = apiRequestLogFilterSchema.parse(rawFilter);
  const where = {
    orgId,
    ...(filter.apiKeyId ? { apiKeyId: filter.apiKeyId } : {}),
    ...(filter.errorsOnly ? { status: { gte: 400 } } : {}),
    ...(filter.path ? { path: ciContains(filter.path) } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    dbInternal.apiRequestLog.count({ where }),
    dbInternal.apiRequestLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: filter.offset,
      take: filter.limit,
    }),
  ]);
  return { rows, total, limit: filter.limit, offset: filter.offset };
}

export async function findApiRequestLog(orgId: string, id: string): Promise<ApiRequestLog | null> {
  return dbInternal.apiRequestLog.findFirst({ where: { id, orgId } });
}
