/**
 * Kundenliste (Seite): Bestandskunden ohne Nummer bekommen beim Aufruf eine, ensureCustomerNumbers
 * laeuft aber nur bei Bedarf. Testjahr 2331 (keine Belegnummern betroffen).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/domain/numbering/ranges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/numbering/ranges")>();
  return { ...actual, ensureCustomerNumbers: vi.fn(actual.ensureCustomerNumbers) };
});

import { dbInternal } from "@/lib/db";
import { ensureCustomerNumbers } from "@/domain/numbering/ranges";
import KundenPage from "@/app/kunden/page";

const base = { addressLine1: "Listenweg 1", postalCode: "10955", city: "Berlin", type: "BUSINESS" };
let orgId = "";

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Kundenseite Test GmbH", addressLine1: "Listenweg 9", postalCode: "10955", city: "Berlin" }, select: { id: true } })).id;
  orgStore.id = orgId;
});

beforeEach(() => {
  vi.mocked(ensureCustomerNumbers).mockClear();
});

describe("Kundenliste: Kundennummern nachtragen", () => {
  it("ein Kunde ohne Nummer bekommt beim Aufruf weiterhin eine", async () => {
    const c = await dbInternal.customer.create({ data: { orgId, name: "Ohne Nummer", ...base }, select: { id: true } });
    await KundenPage({ searchParams: Promise.resolve({}) });
    expect(ensureCustomerNumbers).toHaveBeenCalledTimes(1);
    const after = await dbInternal.customer.findUniqueOrThrow({ where: { id: c.id }, select: { customerNumber: true } });
    expect(after.customerNumber).toBeTruthy();
  });

  it("sind alle Nummern vergeben, wird ensureCustomerNumbers nicht aufgerufen", async () => {
    await KundenPage({ searchParams: Promise.resolve({}) });
    expect(ensureCustomerNumbers).not.toHaveBeenCalled();
  });
});
