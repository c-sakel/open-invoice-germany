/**
 * Phase 10, Task 1 — Integrationstests fuer den withApi-Wrapper (Auth/Scope/Rate-
 * Limit/Idempotenz/Fehlerformat). Eigenes Jahr 2073 (Testjahr-Konvention,
 * plan-header.md). Kein Bezug zu Invoice.number (keine Rechnungen in diesem File) —
 * die "eigener NumberRange-Praefix je Testdatei"-Regel betrifft nur Dateien, die
 * Rechnungen festschreiben.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { GET as pingGet } from "@/app/api/v1/ping/route";

let orgId: string;

async function issueKey(opts: { scopes?: ("read" | "write" | "send" | "admin")[]; expiresAt?: Date | null } = {}) {
  return createApiKey(orgId, { name: `Test-Key ${Math.random().toString(36).slice(2)}`, scopes: opts.scopes ?? ["read"], expiresAt: opts.expiresAt ? opts.expiresAt.toISOString() : null });
}

function req(url: string, opts: { method?: string; token?: string; body?: unknown; idemKey?: string } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.idemKey) headers.set("idempotency-key", opts.idemKey);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "API-Auth Test GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE111111111", taxNumber: "11/111/11111" },
  });
  orgId = org.id;
});

beforeEach(() => {
  resetRateLimits();
});

describe("withApi — Bearer-Auth", () => {
  it("gueltiger Schluessel mit passendem Scope -> 200 + X-RateLimit-Remaining", async () => {
    const key = await issueKey({ scopes: ["read"] });
    const res = await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).not.toBeNull();
    const j = await res.json();
    expect(j.data.pong).toBe(true);
    expect(j.data.orgId).toBe(orgId);
  });

  it("fehlender Authorization-Header -> 401 UNAUTHORIZED", async () => {
    const res = await pingGet(req("http://x/api/v1/ping"));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error.code).toBe("UNAUTHORIZED");
  });

  it("unbekanntes Token -> 401", async () => {
    const res = await pingGet(req("http://x/api/v1/ping", { token: "oig_" + "a".repeat(40) }));
    expect(res.status).toBe(401);
  });

  it("widerrufener Schluessel -> 401", async () => {
    const key = await issueKey({ scopes: ["read"] });
    await dbInternal.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    const res = await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error.code).toBe("UNAUTHORIZED");
  });

  it("abgelaufener Schluessel -> 401", async () => {
    const key = await issueKey({ scopes: ["read"], expiresAt: new Date(Date.now() - 60_000) });
    const res = await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error.code).toBe("UNAUTHORIZED");
  });

  it("falscher Scope -> 403 FORBIDDEN", async () => {
    const key = await issueKey({ scopes: ["write"] }); // ping braucht "read"
    const res = await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error.code).toBe("FORBIDDEN");
  });

  it("aktualisiert lastUsedAt bei erfolgreicher Pruefung", async () => {
    const key = await issueKey({ scopes: ["read"] });
    const before = await dbInternal.apiKey.findUnique({ where: { id: key.id } });
    expect(before?.lastUsedAt).toBeNull();
    await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    const after = await dbInternal.apiKey.findUnique({ where: { id: key.id } });
    expect(after?.lastUsedAt).not.toBeNull();
  });
});

describe("withApi — Rate-Limit", () => {
  it("429 RATE_LIMITED + Retry-After nach Erschoepfung des Kontingents", async () => {
    const key = await issueKey({ scopes: ["read"] });
    // Kontingent (600/min) direkt fuellen statt 600x die Route aufzurufen — schnellerer Test,
    // gleicher Bucket-Schluessel wie src/api/rate-limit.ts (`apikey:<id>`).
    for (let i = 0; i < 600; i++) rateLimit(`apikey:${key.id}`, { limit: 600, windowMs: 60_000 });

    const res = await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    expect(res.status).toBe(429);
    const j = await res.json();
    expect(j.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });
});

describe("withApi — Idempotenz (POST)", () => {
  // Eigene, minimale Demo-Route inline (kein Produktionscode) — testet den
  // withApi-POST-Pfad end-to-end, ohne dass Task 1 bereits eine echte Schreib-Ressource
  // ausliefert (die kommt erst mit Task 2+).
  const echoPost = withApi<Record<string, never>>(async (_req, ctx) => {
    const parsed = z.object({ amountCents: z.number().int() }).parse(ctx.body);
    return apiData({ echoedCents: parsed.amountCents, createdAt: new Date().toISOString() }, 201);
  }, { scope: "write" });

  it("gleicher Idempotency-Key + gleicher Body -> identische Antwort (kein zweiter Effekt)", async () => {
    const key = await issueKey({ scopes: ["write"] });
    const idemKey = `idem-${Math.random().toString(36).slice(2)}`;

    const res1 = await echoPost(req("http://x/api/v1/echo", { method: "POST", token: key.token, body: { amountCents: 1234 }, idemKey }));
    expect(res1.status).toBe(201);
    const j1 = await res1.json();

    const res2 = await echoPost(req("http://x/api/v1/echo", { method: "POST", token: key.token, body: { amountCents: 1234 }, idemKey }));
    expect(res2.status).toBe(201);
    const j2 = await res2.json();

    // Identische Antwort (inkl. createdAt aus dem GESPEICHERTEN ersten Aufruf, nicht neu berechnet).
    expect(j2).toEqual(j1);
  });

  it("gleicher Idempotency-Key + abweichender Body -> 409 IDEMPOTENCY_MISMATCH", async () => {
    const key = await issueKey({ scopes: ["write"] });
    const idemKey = `idem-${Math.random().toString(36).slice(2)}`;

    const res1 = await echoPost(req("http://x/api/v1/echo", { method: "POST", token: key.token, body: { amountCents: 1234 }, idemKey }));
    expect(res1.status).toBe(201);

    const res2 = await echoPost(req("http://x/api/v1/echo", { method: "POST", token: key.token, body: { amountCents: 9999 }, idemKey }));
    expect(res2.status).toBe(409);
    const j2 = await res2.json();
    expect(j2.error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("ohne Idempotency-Key laeuft jeder Aufruf normal durch (kein Replay)", async () => {
    const key = await issueKey({ scopes: ["write"] });
    const res1 = await echoPost(req("http://x/api/v1/echo", { method: "POST", token: key.token, body: { amountCents: 1 } }));
    const res2 = await echoPost(req("http://x/api/v1/echo", { method: "POST", token: key.token, body: { amountCents: 1 } }));
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });
});

describe("withApi — Fehlerformat", () => {
  it("ZodError im Handler -> 400 VALIDATION mit details.issues", async () => {
    const badHandler = withApi(async () => {
      z.object({ x: z.string() }).parse({});
      return NextResponse.json({ data: {} });
    }, { scope: "read" });
    const key = await issueKey({ scopes: ["read"] });
    const res = await badHandler(req("http://x/api/v1/bad", { token: key.token }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe("VALIDATION");
    expect(j.error.details.issues.length).toBeGreaterThan(0);
  });
});
