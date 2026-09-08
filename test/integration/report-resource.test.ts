/** Phase 12e, Task 5 — GET /api/v1/Report. Eigenes Jahr 2087 (Testjahr-Konvention). */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET } from "@/app/api/v1/Report/route";
import { runReport, reportQuerySchema } from "@/domain/reporting/query";

let orgId: string;
let token: string;

function req(url: string, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Report-API GmbH", addressLine1: "R 1", postalCode: "10115", city: "Berlin", vatId: "DE877777777", taxNumber: "87/777/77777" },
  });
  orgId = org.id;
  token = (await createApiKey(orgId, { name: "Report-Leser", scopes: ["read"], expiresAt: null })).token;
});

beforeEach(() => resetRateLimits());

describe("reportQuerySchema", () => {
  it("verlangt einen bekannten Typ und setzt Defaults", () => {
    expect(reportQuerySchema.safeParse({}).success).toBe(false);
    expect(reportQuerySchema.safeParse({ type: "unsinn" }).success).toBe(false);
    expect(reportQuerySchema.parse({ type: "revenue" })).toMatchObject({ months: 12, limit: 5 });
  });
});

describe("GET /api/v1/Report", () => {
  it("revenue liefert 12 Monatspunkte", async () => {
    const res = await GET(req("http://x/api/v1/Report?type=revenue"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data.type).toBe("revenue");
    expect(j.data.rows).toHaveLength(12);
  });
  it("unbekannter Typ -> 400 VALIDATION", async () => {
    const res = await GET(req("http://x/api/v1/Report?type=unsinn"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION");
  });
  it("ohne Token -> 401", async () => {
    expect((await GET(req("http://x/api/v1/Report?type=status", false))).status).toBe(401);
  });
  it("runReport ist der gemeinsame Kern von REST und MCP", async () => {
    const direct = (await runReport(orgId, { type: "status" })) as { type: string };
    expect(direct.type).toBe("status");
  });
});
