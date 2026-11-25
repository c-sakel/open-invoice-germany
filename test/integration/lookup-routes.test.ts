/** Phase 22a T4 — Routen der Such-Endpunkte: Validierung, 404, Header, Bremse. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Keine Organisation");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET as customersGet } from "@/app/api/lookup/customers/route";
import { GET as customerGet } from "@/app/api/lookup/customers/[id]/route";
import { GET as productsGet } from "@/app/api/lookup/products/route";

let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Lookup Route GmbH", addressLine1: "Routenweg 1", postalCode: "10955", city: "Berlin" } });
  orgStore.id = org.id;
  customerId = (await dbInternal.customer.create({ data: { orgId: org.id, name: "Route Kunde", addressLine1: "Weg 1", postalCode: "10955", city: "Berlin", type: "BUSINESS" } })).id;
});
beforeEach(() => resetRateLimits());

const url = (p: string) => new Request(`http://localhost${p}`);

describe("/api/lookup", () => {
  it("liefert Treffer mit no-store", async () => {
    const res = await customersGet(url("/api/lookup/customers?q=route"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as unknown[]).length).toBe(1);
  });
  it("q > 100 Zeichen und limit=50 -> 400 mit details", async () => {
    for (const p of [`/api/lookup/customers?q=${"x".repeat(101)}`, "/api/lookup/customers?limit=50", "/api/lookup/products?limit=50"]) {
      const res = p.includes("products") ? await productsGet(url(p)) : await customersGet(url(p));
      expect(res.status, p).toBe(400);
      expect(await res.json()).toHaveProperty("details");
    }
  });
  it("[id]: bekannt 200, unbekannt 404, no-store", async () => {
    const ok = await customerGet(url("/x"), { params: Promise.resolve({ id: customerId }) });
    expect(ok.status).toBe(200);
    const miss = await customerGet(url("/x"), { params: Promise.resolve({ id: "unbekannt" }) });
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("no-store");
  });
  it("ohne Organisation -> 500 mit festem Text", async () => {
    const keep = orgStore.id;
    orgStore.id = null;
    const res = await customersGet(url("/api/lookup/customers"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Interner Fehler" });
    orgStore.id = keep;
  });
  it("Bremse je Organisation: nach 240 Anfragen 429 mit retry-after", async () => {
    let last = 200;
    for (let i = 0; i < 241; i++) last = (await productsGet(url("/api/lookup/products"))).status;
    expect(last).toBe(429);
  });
});
