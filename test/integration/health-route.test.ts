/**
 * Phase 16a, Task 8 — oeffentlicher Health-Check und Admin-Systemstatus.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import * as health from "@/lib/health";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as systemHealthGet } from "@/app/api/v1/System/health/route";

let orgId: string;

function healthReq(ip = "203.0.113.7") {
  return new Request("http://localhost/api/health", { headers: { "x-forwarded-for": ip } });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Health Test GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE111111111", taxNumber: "11/111/11111" },
  });
  orgId = org.id;
});

beforeEach(() => {
  resetRateLimits();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BACKUP_STATUS_FILE;
});

describe("GET /api/health", () => {
  it("ohne Cookie 200 {status: ok}, genau ein Schluessel, no-store", async () => {
    const res = await healthGet(healthReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok" });
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("checkDb false -> 503 {status: error}", async () => {
    vi.spyOn(health, "checkDb").mockResolvedValue(false);
    const res = await healthGet(healthReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("61. Aufruf derselben IP innerhalb einer Minute -> 429, andere IP unberuehrt", async () => {
    for (let i = 0; i < 60; i++) expect((await healthGet(healthReq())).status).toBe(200);
    const blocked = await healthGet(healthReq());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect((await healthGet(healthReq("198.51.100.9"))).status).toBe(200);
  });
});

describe("Health: Healthcheck-Aufrufer und Timeout", () => {
  it("ohne IP-Header: eigener Bucket mit 600/min (Docker-Healthcheck); 601. -> 429", async () => {
    for (let i = 0; i < 600; i++) expect((await healthGet(new Request("http://localhost/api/health"))).status).toBe(200);
    expect((await healthGet(new Request("http://localhost/api/health"))).status).toBe(429);
    // Bucket mit IP bleibt davon unberuehrt.
    expect((await healthGet(healthReq("198.51.100.9"))).status).toBe(200);
  });

  it("auch Loopback/gespoofte 127.0.0.1 ist je IP auf 60/min begrenzt", async () => {
    for (let i = 0; i < 60; i++) expect((await healthGet(healthReq("127.0.0.1"))).status).toBe(200);
    expect((await healthGet(healthReq("127.0.0.1"))).status).toBe(429);
  });

  it("checkDb: haengende Abfrage -> false nach Timeout", async () => {
    const { dbInternal: db } = await import("@/lib/db");
    vi.spyOn(db, "$queryRaw").mockImplementation((() => new Promise(() => {})) as never);
    const t0 = Date.now();
    expect(await health.checkDb(50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("GET /api/v1/System/health", () => {
  async function call(scopes: ("read" | "write" | "send" | "admin")[]) {
    const key = await createApiKey(orgId, { name: `Health-Key ${Math.random().toString(36).slice(2)}`, scopes, expiresAt: null });
    return systemHealthGet(new Request("http://localhost/api/v1/System/health", { headers: { authorization: `Bearer ${key.token}` } }));
  }

  it("scope read -> 403", async () => {
    expect((await call(["read"])).status).toBe(403);
  });

  it("scope admin -> 200 mit allen fuenf Schluesseln", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-health-"));
    const statusFile = path.join(dir, "status.txt");
    await fs.writeFile(statusFile, "FEHLER 2064-01-01T00:00:00Z x\nOK 2064-01-02T03:04:05Z\n");
    process.env.BACKUP_STATUS_FILE = statusFile;
    const res = await call(["admin"]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(["archive", "backup", "chain", "db", "scheduler"]);
    expect(data.db).toBe(true);
    expect(data.backup).toEqual({ lastOkAt: "2064-01-02T03:04:05Z" });
    expect(data.chain).toBeNull();
    const archive = data.archive as { freeBytes: number | null; pending: number };
    expect(typeof archive.pending).toBe("number");
    expect(archive.freeBytes === null || archive.freeBytes > 0).toBe(true);
    const sched = data.scheduler as Record<string, string | null>;
    expect(Object.keys(sched)).toContain("archive");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
