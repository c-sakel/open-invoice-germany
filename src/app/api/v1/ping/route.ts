/**
 * Demo-Route fuer den withApi-Wrapper (Phase 10, Task 1) — kein eigenes Fach-Feature,
 * dient nur dem End-zu-End-Test des Wrappers (Auth/Scope/Rate-Limit/Fehlerformat).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => {
  return apiData({ pong: true, orgId: ctx.orgId, keyName: ctx.apiKey.name });
}, { scope: "read" });
