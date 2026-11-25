import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { listCustomersPage } from "@/domain/customer/list";

let orgA: string;
let orgB: string;

const base = { addressLine1: "Listenweg 1", postalCode: "10955", city: "Berlin", type: "BUSINESS" };

beforeAll(async () => {
  const a = await dbInternal.organization.create({ data: { legalName: "Liste A GmbH", addressLine1: "Listenweg 1", postalCode: "10955", city: "Berlin" } });
  const b = await dbInternal.organization.create({ data: { legalName: "Liste B GmbH", addressLine1: "Listenweg 2", postalCode: "10955", city: "Berlin" } });
  orgA = a.id;
  orgB = b.id;
  const pad = (n: number) => String(n).padStart(3, "0");
  await dbInternal.customer.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({ orgId: orgA, name: `Kunde ${pad(i + 1)}`, ...base })),
  });
  await dbInternal.customer.create({ data: { orgId: orgA, name: "Becker GmbH", ...base } });
  await dbInternal.customer.create({ data: { orgId: orgA, name: "Zeta AG", email: "becker@example.org", ...base } });
  await dbInternal.customer.create({ data: { orgId: orgA, name: "Archiv Alt", isArchived: true, ...base } });
  await dbInternal.customer.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ orgId: orgB, name: `Becker Fremd ${i}`, ...base })) });
});

describe("listCustomersPage", () => {
  it("liefert 50 Zeilen, Gesamtzahl ohne Archiv, Name aufsteigend", async () => {
    const r = await listCustomersPage(orgA, {});
    expect(r.rows).toHaveLength(50);
    expect(r.total).toBe(122);
    const names = r.rows.map((x) => x.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
  });

  it("offset blaettert bis zur letzten Seite", async () => {
    const r = await listCustomersPage(orgA, { offset: "100" });
    expect(r.rows).toHaveLength(22);
  });

  it("Suche findet Name und E-Mail, nie fremde Org", async () => {
    const r = await listCustomersPage(orgA, { q: "becker" });
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x.name).sort()).toEqual(["Becker GmbH", "Zeta AG"]);
  });

  it("archiviert=1 enthaelt Archivierte", async () => {
    const r = await listCustomersPage(orgA, { archiviert: "1" });
    expect(r.total).toBe(123);
  });

  it("q mit 101 Zeichen wird abgelehnt", async () => {
    await expect(listCustomersPage(orgA, { q: "x".repeat(101) })).rejects.toThrow();
  });

  it("Zeilen enthalten nur die Listenfelder und hoechstens einen Kontakt", async () => {
    const r = await listCustomersPage(orgA, {});
    expect(Object.keys(r.rows[0]).sort()).toEqual(["city", "contacts", "id", "name", "type", "vatId", "customerNumber"].sort());
    for (const row of r.rows) expect(row.contacts.length).toBeLessThanOrEqual(1);
  });
});
