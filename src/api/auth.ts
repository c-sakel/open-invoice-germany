/**
 * withApi — gemeinsamer Wrapper fuer jede /api/v1/*-Route (Phase 10, Task 1).
 *
 * Ablauf je Aufruf: Bearer-Token pruefen (src/domain/api-key/verify.ts) -> Scope
 * pruefen -> Rate-Limit verbrauchen (600/min je Schluessel) -> bei POST mit
 * `Idempotency-Key` eine bereits abgeschlossene Antwort ausliefern ODER die Zeile
 * reserve-first anlegen (Fix-Runde 1 S1, Wettlauf-Schutz ueber
 * @@unique([orgId,key]) — siehe src/api/idempotency.ts fuer die Zustandsmaschine)
 * -> Fehler einheitlich mappen (src/api/errors.ts). `/api/v1/*` akzeptiert
 * AUSSCHLIESSLICH Bearer — kein Cookie-Fallback (task-1-facts.md); der Proxy
 * (src/proxy.ts) laesst den Pfad ohne Session durch, die eigentliche Pruefung
 * passiert ausschliesslich hier.
 *
 * Handler-Vertrag fuer Tasks 2-5: `withApi(handler, { scope })` liefert einen
 * Next.js-Routen-Handler `(req, routeCtx?) => Promise<NextResponse>`. Der Handler
 * bekommt das ORIGINALE `req` (Header/URL nutzbar, Body-Stream bereits konsumiert —
 * NIE erneut `req.json()`/`req.text()` aufrufen) sowie `ctx`:
 *   - ctx.orgId       — Organisation des Schluessels (fuer jede Query/jeden Write)
 *   - ctx.apiKey       — { id, orgId, name, scopes }
 *   - ctx.actor        — "api:<slug>" fuer appendChangeLog/ActivityLog (Audit-Ruling)
 *   - ctx.params        — bereits aufgeloeste Routen-Parameter ([id] etc.)
 *   - ctx.body           — bei PATCH/POST/PUT das geparste JSON (oder `undefined`
 *                            ohne Body); die Route validiert es selbst mit dem
 *                            passenden Zod-Schema (kein Bypass, §50/§55)
 * Rueckgabe: der Handler liefert `apiData`/`apiList` (src/api/response.ts) oder wirft
 * — withApi mappt jeden Wurf einheitlich. `X-RateLimit-Remaining` wird auf JEDE
 * Antwort (Erfolg wie Fehler-Idempotenz-Replay) gesetzt.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApiKeyScope } from "@/schemas";
import { verifyApiToken, requireScope, type VerifiedApiKey } from "@/domain/api-key/verify";
import { slugifyKeyName } from "@/domain/api-key/create";
import { checkApiRateLimit, attachRateLimitHeader } from "./rate-limit";
import { beginIdempotency, completeIdempotency, abandonIdempotency } from "./idempotency";
import { apiError } from "./errors";

const IDEMPOTENCY_HEADER = "idempotency-key";
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export interface ApiContext<TParams = Record<string, string>> {
  orgId: string;
  apiKey: VerifiedApiKey;
  actor: string;
  params: TParams;
  body: unknown;
}

export type ApiRouteContext<TParams> = { params: Promise<TParams> };

export type ApiHandler<TParams = Record<string, string>> = (req: Request, ctx: ApiContext<TParams>) => Promise<NextResponse>;

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

function invalidIdempotencyKeyError(): z.ZodError {
  return new z.ZodError([{ code: "custom", path: ["Idempotency-Key"], message: `Idempotency-Key muss 1..${MAX_IDEMPOTENCY_KEY_LENGTH} Zeichen lang sein.` }]);
}

export function withApi<TParams = Record<string, string>>(handler: ApiHandler<TParams>, opts: { scope: ApiKeyScope }) {
  return async (req: Request, routeCtx?: ApiRouteContext<TParams>): Promise<NextResponse> => {
    try {
      const apiKey = await verifyApiToken(bearerToken(req));
      requireScope(apiKey, opts.scope);
      const remaining = checkApiRateLimit(apiKey.id);

      const method = req.method.toUpperCase();
      const url = new URL(req.url);
      const params = routeCtx ? await routeCtx.params : ({} as TParams);

      let rawBody = "";
      let body: unknown;
      if (BODY_METHODS.has(method)) {
        rawBody = await req.text();
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            throw new z.ZodError([{ code: "custom", path: [], message: "Ungueltiges JSON im Request-Body." }]);
          }
        }
      }

      const actor = `api:${slugifyKeyName(apiKey.name)}`;
      const ctx: ApiContext<TParams> = { orgId: apiKey.orgId, apiKey, actor, params, body };

      const idemKey = req.headers.get(IDEMPOTENCY_HEADER)?.trim() || undefined;
      const usesIdempotency = method === "POST" && idemKey !== undefined;
      if (usesIdempotency) {
        if (idemKey!.length < 1 || idemKey!.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw invalidIdempotencyKeyError();
        // Reserve-First (Fix-Runde 1 S1): entweder eine bereits abgeschlossene Antwort
        // (Replay), oder die Reservierung fuer DIESEN Aufruf gelingt (null) — ein
        // gleichzeitiger zweiter Aufruf mit demselben Key wirft IdempotencyInProgressError
        // (409), bevor der Handler ueberhaupt startet. Siehe src/api/idempotency.ts.
        const replay = await beginIdempotency(ctx.orgId, idemKey!, method, url.pathname, rawBody);
        if (replay) {
          return attachRateLimitHeader(NextResponse.json(replay.body, { status: replay.status }), remaining);
        }
      }

      let res: NextResponse;
      try {
        res = await handler(req, ctx);
      } catch (e) {
        // Handler warf -> Reservierung wieder entfernen, damit ein Retry mit demselben
        // Idempotency-Key normal (nicht als IN_PROGRESS haengend) laeuft.
        if (usesIdempotency) await abandonIdempotency(ctx.orgId, idemKey!);
        throw e;
      }

      if (usesIdempotency) {
        if (res.status < 500) {
          const replayBody = await res.clone().json().catch(() => null);
          await completeIdempotency(ctx.orgId, idemKey!, res.status, replayBody);
        } else {
          // 5xx gilt als transient -> Reservierung entfernen statt den Serverfehler
          // dauerhaft zu replizieren (GoBD verlangt keine Replikation eines Serverfehlers).
          await abandonIdempotency(ctx.orgId, idemKey!);
        }
      }

      return attachRateLimitHeader(res, remaining);
    } catch (e) {
      return apiError(e);
    }
  };
}
