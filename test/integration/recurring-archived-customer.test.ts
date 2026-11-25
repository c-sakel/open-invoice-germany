/**
 * Abo anlegen: archivierte Kunden werden serverseitig abgelehnt (Domain, REST und MCP teilen
 * createRecurring). Es entsteht kein Beleg; Testjahr 2291 (nur Stichtage).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring, RecurringError } from "@/domain/recurring/create";
import { createRecurringSchema } from "@/schemas";

const START = new Date("2291-03-01T10:00:00.000Z");
const item = { lineType: "ITEM", description: "Wartung", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

let orgId: string;
let activeId: string;
let archivedId: string;

function input(customerId: string) {
  return createRecurringSchema.parse({ customerId, title: "Abo", startDate: START, lines: [item] });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Abo-Archiv GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const base = { orgId, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" as const, email: "kunde@example.org" };
  activeId = (await dbInternal.customer.create({ data: { ...base, name: "Aktiver Kunde AG" }, select: { id: true } })).id;
  archivedId = (await dbInternal.customer.create({ data: { ...base, name: "Archivierter Kunde AG", isArchived: true }, select: { id: true } })).id;
});

describe("createRecurring und archivierte Kunden", () => {
  it("lehnt archivierte Kunden ab und legt nichts an", async () => {
    await expect(createRecurring(orgId, input(archivedId))).rejects.toThrow(RecurringError);
    await expect(createRecurring(orgId, input(archivedId))).rejects.toThrow(/Archivierte Kunden/);
    expect(await dbInternal.recurringInvoice.count({ where: { orgId, customerId: archivedId } })).toBe(0);
  });

  it("aktive Kunden funktionieren weiterhin", async () => {
    const rec = await createRecurring(orgId, input(activeId));
    expect(rec.customerId).toBe(activeId);
  });
});
