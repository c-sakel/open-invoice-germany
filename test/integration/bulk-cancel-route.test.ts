/**
 * Phase 18c, Task 3: Routen des Sammel-Stornos (Session-Auth/Org gemockt). Eigenes Testjahr 2172.
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "route-tester" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createInvoiceSchema } from "@/schemas";
import { resetRateLimits } from "@/lib/rate-limit";
import { POST as bulkPost } from "@/app/api/invoices/bulk-cancel/route";
import { POST as previewPost } from "@/app/api/invoices/bulk-cancel/preview/route";

const NOW = new Date("2172-05-01T10:00:00.000Z");
// Belegnummern sind instanzweit eindeutig: die Fremd-Org nutzt ein eigenes Jahr.
const NOW_OTHER = new Date("2173-05-01T10:00:00.000Z");
let orgId: string;
let otherOrgId: string;
let customerId: string;
let otherCustomerId: string;

async function mkOrg(name: string, vat: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "55/666/77778" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  const c = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: c.id };
}

async function draft(org: string, cust: string, at = NOW) {
  return createDraftInvoice(
    org,
    createInvoiceSchema.parse({
      customerId: cust,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: at,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: at },
  );
}
const finalized = async (org: string, cust: string, at = NOW) => finalizeInvoice((await draft(org, cust, at)).id, { now: at });

const post = (handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  handler(new Request("http://localhost/api", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));

beforeAll(async () => {
  ({ orgId, customerId } = await mkOrg("Sammelroute GmbH", "DE555666779"));
  ({ orgId: otherOrgId, customerId: otherCustomerId } = await mkOrg("Fremde Route GmbH", "DE888999002"));
  orgStore.id = orgId;
});
beforeEach(() => resetRateLimits());

describe("POST /api/invoices/bulk-cancel", () => {
  it("storniert Rechnungen, meldet Entwurf als Fehler, no-store, Akteur aus Session", async () => {
    const a = await finalized(orgId, customerId);
    const b = await finalized(orgId, customerId);
    const d = await draft(orgId, customerId);
    const res = await post(bulkPost, { ids: [a.id, b.id, d.id], reason: "Doppelt", confirm: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const j = (await res.json()) as { ok: unknown[]; failed: { code: string }[] };
    expect(j.ok).toHaveLength(2);
    expect(j.failed[0].code).toBe("NOT_CANCELLABLE");
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entityId: a.id, action: "CANCEL" }, select: { actor: true } });
    expect(log.actor).toBe("route-tester");
  });
  it("lehnt 51 Ids, fehlenden Grund und fehlende Bestätigung ab (400)", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id${i}`);
    const r1 = await post(bulkPost, { ids, reason: "x", confirm: true });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    expect((await post(bulkPost, { ids: ["a"], confirm: true })).status).toBe(400);
    expect((await post(bulkPost, { ids: ["a"], reason: "x" })).status).toBe(400);
  });
  it("415 ohne JSON, 400 bei kaputtem JSON", async () => {
    expect((await post(bulkPost, "{}", { "content-type": "text/plain" })).status).toBe(415);
    const r = await post(bulkPost, "{kaputt");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("Ungültiges JSON im Request-Body.");
  });
  it("Rate-Limit: 429 nach 10 Aufrufen je Minute", async () => {
    for (let i = 0; i < 10; i++) expect((await post(bulkPost, { ids: ["x"], reason: "r", confirm: true })).status).toBe(200);
    const r = await post(bulkPost, { ids: ["x"], reason: "r", confirm: true });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

describe("POST /api/invoices/bulk-cancel/preview", () => {
  it("liefert Vorschauen, fremde Ids landen in missing", async () => {
    const a = await finalized(orgId, customerId);
    const b = await finalized(orgId, customerId);
    const foreign = await finalized(otherOrgId, otherCustomerId, NOW_OTHER);
    const res = await post(previewPost, { ids: [a.id, b.id, foreign.id] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const j = (await res.json()) as { previews: unknown[]; missing: string[] };
    expect(j.previews).toHaveLength(2);
    expect(j.missing).toEqual([foreign.id]);
  });
  it("415 ohne JSON", async () => {
    expect((await post(previewPost, "{}", { "content-type": "text/plain" })).status).toBe(415);
  });
});
