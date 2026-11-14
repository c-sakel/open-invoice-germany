/**
 * Phase 18f, Task 8: Sitzungs-Routen der Verbrauchserfassung (Org/Nutzer gemockt).
 * Praefix V18F8-, eigenes Testjahr 2185, kein Netz.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";

const orgStore = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "V18F8-user" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { createRecurringSchema } from "@/schemas";
import { POST as usagePost } from "@/app/api/recurring/[id]/usage/route";
import { DELETE as usageDelete } from "@/app/api/recurring/[id]/usage/[usageId]/route";

const NOW = new Date("2185-03-25T10:00:00.000Z");
let orgId: string;
let otherOrgId: string;
let recurringId: string;
let usageLineId: string;
let fixedLineId: string;

const json = { "content-type": "application/json" };
const post = (id: string, body: unknown, headers: Record<string, string> = json) =>
  usagePost(new Request("http://localhost/api", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const del = (id: string, usageId: string, body: unknown, headers: Record<string, string> = json) =>
  usageDelete(new Request("http://localhost/api", { method: "DELETE", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id, usageId }) });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const mk = async (name: string) => {
    const org = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: "DE123456789", taxNumber: "33/123/45678" } });
    await ensureOrgMasterdata(dbInternal, org.id);
    return org.id;
  };
  orgId = await mk("V18F8-Org GmbH");
  otherOrgId = await mk("V18F8-Fremd GmbH");
  orgStore.id = orgId;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "V18F8-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const rec = await createRecurring(
    orgId,
    createRecurringSchema.parse({
      customerId: customer.id,
      title: "V18F8-Abo",
      startDate: new Date("2185-03-31T10:00:00.000Z"),
      lines: [
        { lineType: "ITEM", description: "Grundgebühr", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 },
        { lineType: "ITEM", description: "API-Aufrufe", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, billing: "USAGE", usageUnitLabel: "Aufrufe" },
      ],
    }),
  );
  recurringId = rec.id;
  usageLineId = rec.lines.find((l) => l.billing === "USAGE")?.id ?? "";
  fixedLineId = rec.lines.find((l) => l.billing === "FIXED")?.id ?? "";
});

afterAll(() => {
  vi.useRealTimers();
  orgStore.id = null;
});

describe("POST /api/recurring/[id]/usage", () => {
  it("erfasst mit Quelle UI und Akteur = Nutzer-Id", async () => {
    const res = await post(recurringId, { recurringLineId: usageLineId, quantityMilli: 6_000_000, usageDate: "2185-03-10", note: "V18F8-Messung" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { usage: { id: string; source: string; status: string } };
    expect(body.usage).toMatchObject({ source: "UI", status: "open" });
    const row = await dbInternal.recurringUsage.findFirstOrThrow({ where: { id: body.usage.id }, select: { source: true, createdBy: true, orgId: true } });
    expect(row).toEqual({ source: "UI", createdBy: "V18F8-user", orgId });
  });

  it("lehnt Content-Type != JSON mit 415 ab", async () => {
    const res = await post(recurringId, "quantityMilli=1", { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("fremde Org und unbekannte Position -> 404, Fachfehler -> 422, Eingabefehler -> 400 mit Feld", async () => {
    orgStore.id = otherOrgId;
    expect((await post(recurringId, { recurringLineId: usageLineId, quantityMilli: 1000 })).status).toBe(404);
    orgStore.id = orgId;
    expect((await post(recurringId, { recurringLineId: "gibt-es-nicht", quantityMilli: 1000 })).status).toBe(404);
    const notUsage = await post(recurringId, { recurringLineId: fixedLineId, quantityMilli: 1000 });
    expect(notUsage.status).toBe(422);
    expect(((await notUsage.json()) as { code: string }).code).toBe("NOT_USAGE_LINE");
    const invalid = await post(recurringId, { recurringLineId: usageLineId, quantityMilli: 0 });
    expect(invalid.status).toBe(400);
    expect(Object.keys(((await invalid.json()) as { fields: Record<string, string> }).fields)).toContain("quantityMilli");
    expect((await post(recurringId, "{kaputt")).status).toBe(400);
  });
});

describe("DELETE /api/recurring/[id]/usage/[usageId]", () => {
  it("storniert mit Grund; zweites Storno 422, ohne Grund 400, fremde Org 404, kein JSON 415", async () => {
    const created = (await (await post(recurringId, { recurringLineId: usageLineId, quantityMilli: 1_000, usageDate: "2185-03-11" })).json()) as { usage: { id: string } };
    const id = created.usage.id;
    expect((await del(recurringId, id, { reason: "x" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await del(recurringId, id, { reason: "   " })).status).toBe(400);
    orgStore.id = otherOrgId;
    expect((await del(recurringId, id, { reason: "Fremd" })).status).toBe(404);
    orgStore.id = orgId;

    const res = await del(recurringId, id, { reason: "Doppelt gemeldet" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { usage: { status: string; voidReason: string } }).usage).toMatchObject({ status: "voided", voidReason: "Doppelt gemeldet" });
    const row = await dbInternal.recurringUsage.findFirstOrThrow({ where: { id }, select: { voidedBy: true, voidedAt: true } });
    expect(row.voidedBy).toBe("V18F8-user");
    expect(row.voidedAt).not.toBeNull();

    const again = await del(recurringId, id, { reason: "nochmal" });
    expect(again.status).toBe(422);
    expect(((await again.json()) as { code: string }).code).toBe("ALREADY_VOIDED");
  });
});
