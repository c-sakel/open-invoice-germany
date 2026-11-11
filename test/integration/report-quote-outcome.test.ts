/** Phase 16f, Task 5 — quoteOutcome. Eigenes Jahr 2105. */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { quoteOutcome } from "@/domain/reporting/quote-outcome";

const NOW = new Date(Date.UTC(2105, 5, 15, 10));
const MARCH = new Date(Date.UTC(2105, 2, 10, 10));

async function mkOrg(name: string) {
  const o = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Q 1", postalCode: "10115", city: "Berlin", vatId: "DE822222222", taxNumber: "82/222/22222" } });
  const c = await dbInternal.customer.create({ data: { orgId: o.id, name: "Kunde", addressLine1: "A 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } });
  return { orgId: o.id, customerId: c.id };
}
async function quote(o: { orgId: string; customerId: string }, status: string, netTotalCents: number, extra: { validUntil?: Date; kind?: string; issueDate?: Date; currency?: string } = {}) {
  return dbInternal.quote.create({
    data: { orgId: o.orgId, customerId: o.customerId, status, netTotalCents, kind: extra.kind ?? "ANGEBOT", issueDate: extra.issueDate ?? MARCH, validUntil: extra.validUntil, currency: extra.currency ?? "EUR" },
  });
}

describe("quoteOutcome", () => {
  it("zählt ACCEPTED/REJECTED/EXPIRED/offen", async () => {
    const o = await mkOrg("Quote A GmbH");
    await quote(o, "ACCEPTED", 1000);
    await quote(o, "ACCEPTED", 500);
    await quote(o, "REJECTED", 300);
    await quote(o, "EXPIRED", 200);
    await quote(o, "SENT", 100, { validUntil: new Date(Date.UTC(2105, 11, 31)) });
    const [r] = await quoteOutcome(o.orgId, { months: 6, now: NOW });
    expect(r.accepted).toEqual({ count: 2, netCents: 1500 });
    expect(r.rejected).toEqual({ count: 1, netCents: 300 });
    expect(r.expired).toEqual({ count: 1, netCents: 200 });
    expect(r.open).toEqual({ count: 1, netCents: 100 });
  });

  it("SENT mit validUntil gestern = expired", async () => {
    const o = await mkOrg("Quote B GmbH");
    await quote(o, "SENT", 100, { validUntil: new Date(Date.UTC(2105, 5, 14, 12)) });
    await quote(o, "SENT", 100, { validUntil: new Date(Date.UTC(2105, 5, 15, 0)) });
    const [r] = await quoteOutcome(o.orgId, { months: 6, now: NOW });
    expect(r.expired.count).toBe(1);
    expect(r.open.count).toBe(1);
  });

  it("DRAFT und CANCELLED ausgeschlossen (auch Nicht-Angebote und außerhalb des Fensters)", async () => {
    const o = await mkOrg("Quote C GmbH");
    await quote(o, "DRAFT", 100);
    await quote(o, "CANCELLED", 100);
    await quote(o, "ACCEPTED", 100, { kind: "AUFTRAGSBESTAETIGUNG" });
    await quote(o, "ACCEPTED", 100, { issueDate: new Date(Date.UTC(2104, 0, 5)) });
    expect(await quoteOutcome(o.orgId, { months: 6, now: NOW })).toEqual([]);
  });

  it("acceptedPermille 2 von 3 = 667", async () => {
    const o = await mkOrg("Quote D GmbH");
    await quote(o, "ACCEPTED", 1);
    await quote(o, "ACCEPTED", 1);
    await quote(o, "REJECTED", 1);
    await quote(o, "SENT", 1, { validUntil: new Date(Date.UTC(2105, 11, 31)) });
    const [r] = await quoteOutcome(o.orgId, { months: 6, now: NOW });
    expect(r.acceptedPermille).toBe(667);
  });

  it("ohne Entscheidung null", async () => {
    const o = await mkOrg("Quote E GmbH");
    await quote(o, "SENT", 1, { validUntil: new Date(Date.UTC(2105, 11, 31)) });
    const [r] = await quoteOutcome(o.orgId, { months: 6, now: NOW });
    expect(r.acceptedPermille).toBeNull();
  });

  it("fremde Org unsichtbar, Währungen getrennt", async () => {
    const o = await mkOrg("Quote F GmbH");
    const other = await mkOrg("Quote G GmbH");
    await quote(o, "ACCEPTED", 100);
    await quote(o, "ACCEPTED", 200, { currency: "USD" });
    const rows = await quoteOutcome(o.orgId, { months: 6, now: NOW });
    expect(rows.map((r) => [r.currency, r.accepted.netCents])).toEqual([["EUR", 100], ["USD", 200]]);
    expect(await quoteOutcome(other.orgId, { months: 6, now: NOW })).toEqual([]);
  });

  it("in Rechnung umgewandeltes Angebot (SENT, abgelaufen) zählt als angenommen", async () => {
    const o = await mkOrg("Quote H GmbH");
    const q = await quote(o, "SENT", 700, { validUntil: new Date(Date.UTC(2105, 4, 1)) });
    await dbInternal.quote.update({ where: { id: q.id }, data: { convertedToInvoiceId: "inv-umgewandelt" } });
    await quote(o, "REJECTED", 100);
    const [r] = await quoteOutcome(o.orgId, { months: 6, now: NOW });
    expect(r.accepted).toEqual({ count: 1, netCents: 700 });
    expect(r.expired.count).toBe(0);
    expect(r.acceptedPermille).toBe(500);
  });
});
