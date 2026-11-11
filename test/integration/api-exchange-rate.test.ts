/**
 * Phase 16b, Task 9 — REST /api/v1/ExchangeRate (GET, POST) und /refresh. Eigenes Testjahr 2112
 * (Kurse sind instanzweit; die Zeilen dieses Tests liegen im Jahr 2112 und werden aufgeraeumt).
 * `FX_AUTO_FETCH=0` (vitest.config.ts): der Abruf laeuft nie ins Netz.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET as RateGet, POST as RatePost } from "@/app/api/v1/ExchangeRate/route";
import { POST as RateRefresh } from "@/app/api/v1/ExchangeRate/refresh/route";

let orgId: string;
let adminToken: string;
let readToken: string;

const MARCH = new Date("2112-03-01T00:00:00.000Z");

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function cleanup(): Promise<void> {
  await dbInternal.exchangeRate.deleteMany({ where: { rateDate: { gte: new Date("2112-01-01"), lt: new Date("2113-01-01") } } });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Kurs-API GmbH", addressLine1: "Kursweg 2", postalCode: "10115", city: "Berlin", vatId: "DE211221122", taxNumber: "21/112/00000" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, fxRateSource: "BMF_MONTHLY" }, update: { fxRateSource: "BMF_MONTHLY" } });
  adminToken = (await createApiKey(orgId, { name: "Kurs-Admin", scopes: ["read", "write", "admin"] })).token;
  readToken = (await createApiKey(orgId, { name: "Kurs-Read", scopes: ["read"] })).token;
  await cleanup();
});

beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await cleanup();
  await dbInternal.$disconnect();
});

describe("GET /api/v1/ExchangeRate", () => {
  it("liefert mit Quelle BMF_MONTHLY den Monatskurs", async () => {
    await dbInternal.exchangeRate.createMany({
      data: [
        { source: "MONTHLY", currency: "USD", rateDate: MARCH, rateMicros: 1_121_400, origin: "MANUAL" },
        { source: "ECB", currency: "USD", rateDate: new Date("2112-03-12T00:00:00.000Z"), rateMicros: 1_200_000, origin: "IMPORTED" },
      ],
    });
    const res = await RateGet(req("http://x/api/v1/ExchangeRate?currency=USD&date=2112-03-12", { token: readToken }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ currency: "USD", rate: "1.1214", rateDate: "2112-03-01", source: "BMF_MONTHLY" });
  });

  it("404 ohne Kurs", async () => {
    const res = await RateGet(req("http://x/api/v1/ExchangeRate?currency=CHF&date=2112-03-12", { token: readToken }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("400 bei ungueltiger Waehrung (Zod)", async () => {
    const res = await RateGet(req("http://x/api/v1/ExchangeRate?currency=US&date=2112-03-12", { token: readToken }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION");
  });

  it("400 bei ungueltigem Datum", async () => {
    const res = await RateGet(req("http://x/api/v1/ExchangeRate?currency=USD&date=2112-13-40", { token: readToken }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/ExchangeRate", () => {
  it("rate \"1,1214\" -> 201, origin MANUAL, in der Tabelle", async () => {
    const res = await RatePost(
      req("http://x/api/v1/ExchangeRate", { method: "POST", token: adminToken, body: { source: "ECB", currency: "GBP", rateDate: "2112-05-04", rate: "1,1214", note: "Test" } }),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ objectName: "ExchangeRate", source: "ECB", currency: "GBP", rateDate: "2112-05-04", rate: "1.1214", origin: "MANUAL", note: "Test" });
    const row = await dbInternal.exchangeRate.findFirstOrThrow({ where: { currency: "GBP", rateDate: new Date("2112-05-04T00:00:00.000Z") }, select: { rateMicros: true, origin: true } });
    expect(row).toEqual({ rateMicros: 1_121_400, origin: "MANUAL" });
  });

  it("Monatsdurchschnitt landet auf dem Monatsersten", async () => {
    const res = await RatePost(
      req("http://x/api/v1/ExchangeRate", { method: "POST", token: adminToken, body: { source: "MONTHLY", currency: "SEK", rateDate: "2112-06-17", rate: "11.5" } }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).data.rateDate).toBe("2112-06-01");
  });

  it("rate \"abc\" -> 400", async () => {
    const res = await RatePost(
      req("http://x/api/v1/ExchangeRate", { method: "POST", token: adminToken, body: { source: "ECB", currency: "GBP", rateDate: "2112-05-04", rate: "abc" } }),
    );
    expect(res.status).toBe(400);
  });

  it("rate \"0\" -> 400", async () => {
    const res = await RatePost(
      req("http://x/api/v1/ExchangeRate", { method: "POST", token: adminToken, body: { source: "ECB", currency: "GBP", rateDate: "2112-05-04", rate: "0" } }),
    );
    expect(res.status).toBe(400);
  });

  it("Scope read reicht nicht -> 403", async () => {
    const res = await RatePost(
      req("http://x/api/v1/ExchangeRate", { method: "POST", token: readToken, body: { source: "ECB", currency: "GBP", rateDate: "2112-05-04", rate: "1,1" } }),
    );
    expect(res.status).toBe(403);
  });

  it("ohne Schluessel -> 401", async () => {
    const res = await RateGet(req("http://x/api/v1/ExchangeRate?currency=USD&date=2112-03-12"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/ExchangeRate/refresh", () => {
  it("FX_AUTO_FETCH=0 -> 409 reason disabled, kein Netz", async () => {
    expect(process.env.FX_AUTO_FETCH).toBe("0");
    const res = await RateRefresh(req("http://x/api/v1/ExchangeRate/refresh", { method: "POST", token: adminToken }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.reason).toBe("disabled");
  });
});
