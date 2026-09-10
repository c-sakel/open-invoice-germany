/**
 * Fix-Welle 1 (Phase 13a Final-Review, M2) — `applyCustomerComboFilter`
 * (`src/domain/customer/list.ts`): loest den Rohwert des "combo"-Kundenfilters der
 * Listenseiten (FilterBar, Feld `customerId`) serverseitig auf. Mit UND ohne JavaScript
 * kommt seit Fix M2 derselbe Rohtext an — entweder eine Id (Link/Lesezeichen) oder ein
 * per <datalist> getippter Kundenname.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { applyCustomerComboFilter } from "@/domain/customer/list";

let orgId: string;
let otherOrgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Kundenfilter Test GmbH", addressLine1: "Filterweg 1", postalCode: "10999", city: "Berlin", vatId: "DE999888111", taxNumber: "21/555/99991" },
  });
  orgId = org.id;
  const otherOrg = await dbInternal.organization.create({
    data: { legalName: "Fremdorg Filter GmbH", addressLine1: "Fremdweg 1", postalCode: "10998", city: "Berlin" },
  });
  otherOrgId = otherOrg.id;

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Mueller GmbH", addressLine1: "Kundenring 1", postalCode: "10997", city: "Berlin", type: "BUSINESS" },
  });
  customerId = customer.id;
  // Fremdkunde derselben Organisation mit anderem Namen — Kollisionscheck.
  await dbInternal.customer.create({
    data: { orgId, name: "Andere Firma AG", addressLine1: "Ringstr. 2", postalCode: "10996", city: "Berlin", type: "BUSINESS" },
  });
  // Gleichnamiger Kunde in einer FREMDEN Organisation — darf NICHT gefunden werden.
  await dbInternal.customer.create({
    data: { orgId: otherOrgId, name: "Mueller GmbH", addressLine1: "Fremdring 1", postalCode: "10995", city: "Berlin", type: "BUSINESS" },
  });
});

describe("applyCustomerComboFilter", () => {
  it("ohne customerId im Filter: keine Wirkung", async () => {
    const filter: Record<string, unknown> = { q: "Suchtext" };
    await applyCustomerComboFilter(orgId, filter);
    expect(filter).toEqual({ q: "Suchtext" });
  });

  it("exakte Id: bleibt als customerId stehen (Link/Lesezeichen, z. B. ?customerId=<cuid>)", async () => {
    const filter: Record<string, unknown> = { customerId };
    await applyCustomerComboFilter(orgId, filter);
    expect(filter).toEqual({ customerId });
  });

  it("exakter Kundenname (per <datalist> getippt): loest auf die Id auf", async () => {
    const filter: Record<string, unknown> = { customerId: "Mueller GmbH" };
    await applyCustomerComboFilter(orgId, filter);
    expect(filter).toEqual({ customerId });
  });

  it("kein Treffer: faellt auf `q` zurueck (Spec-Zusage), customerId verschwindet", async () => {
    const filter: Record<string, unknown> = { customerId: "Kein Kunde mit diesem Namen" };
    await applyCustomerComboFilter(orgId, filter);
    expect(filter).toEqual({ q: "Kein Kunde mit diesem Namen" });
  });

  it("kein Treffer, aber bereits ein eigener Suchbegriff gesetzt: `q` bleibt unangetastet, customerId verschwindet trotzdem", async () => {
    const filter: Record<string, unknown> = { customerId: "Unbekannt", q: "eigene Suche" };
    await applyCustomerComboFilter(orgId, filter);
    expect(filter).toEqual({ q: "eigene Suche" });
  });

  it("Fremdorganisation: ein Name, der nur dort existiert, zaehlt NICHT als Treffer (Org-Isolation)", async () => {
    const filter: Record<string, unknown> = { customerId: "Mueller GmbH" };
    await applyCustomerComboFilter(otherOrgId, filter);
    // In otherOrgId existiert ebenfalls ein "Mueller GmbH" — der MUSS dort aufgeloest
    // werden (eigener Kunde), NICHT der aus `orgId`.
    const resolved = await dbInternal.customer.findFirst({ where: { orgId: otherOrgId, name: "Mueller GmbH" }, select: { id: true } });
    expect(filter).toEqual({ customerId: resolved!.id });
    expect(filter.customerId).not.toBe(customerId);
  });
});
