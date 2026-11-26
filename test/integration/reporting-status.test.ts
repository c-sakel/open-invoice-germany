/**
 * statusCounts: Zaehlung geschlossener Status per groupBy, nur offene Status werden geladen.
 * Erwartungswerte wurden vor der Umstellung mit der Volltabellen-Fassung festgehalten.
 * Testjahr 2331 (keine Belegnummern betroffen). Alle Tagesgrenzen UTC.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { statusCounts } from "@/domain/reporting/status";

const NOW = new Date(Date.UTC(2331, 5, 15, 10, 0, 0));
const d = (m: number, day: number) => new Date(Date.UTC(2331, m - 1, day));
let orgId = "";
let emptyOrgId = "";
let customerId = "";

async function mk(data: { status: string; type?: string; dueDate?: Date | null; gross: number; paid?: number }): Promise<void> {
  await dbInternal.invoice.create({
    data: {
      orgId,
      customerId,
      status: data.status,
      type: data.type ?? "INVOICE",
      dueDate: data.dueDate ?? null,
      grossTotalCents: data.gross,
      paidAmountCents: data.paid ?? 0,
      issueDate: d(5, 1),
    },
  });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Status Test GmbH", addressLine1: "Zaehlweg 1", postalCode: "10115", city: "Berlin" }, select: { id: true } });
  orgId = org.id;
  emptyOrgId = (await dbInternal.organization.create({ data: { legalName: "Status Leer GmbH", addressLine1: "Zaehlweg 2", postalCode: "10115", city: "Berlin" }, select: { id: true } })).id;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Status Kunde", addressLine1: "Zaehlweg 3", postalCode: "10115", city: "Berlin", type: "BUSINESS" }, select: { id: true } })).id;
  await mk({ status: "DRAFT", gross: 1000 });
  await mk({ status: "FINALIZED", dueDate: d(7, 1), gross: 2000 });
  await mk({ status: "SENT", dueDate: d(6, 20), gross: 3000 });
  await mk({ status: "FINALIZED", dueDate: d(6, 15), gross: 4000 });
  await mk({ status: "SENT", dueDate: d(6, 1), gross: 5000 });
  await mk({ status: "PARTIALLY_PAID", dueDate: d(6, 1), gross: 6000, paid: 1000 });
  await mk({ status: "PARTIALLY_PAID", dueDate: d(7, 1), gross: 7000, paid: 2000 });
  await mk({ status: "PAID", gross: 8000, paid: 8000 });
  await mk({ status: "CANCELLED", gross: 100 });
  await mk({ status: "CANCELLED", gross: 200 });
  await mk({ status: "FINALIZED", type: "CREDIT_NOTE", gross: -900 });
  await mk({ status: "FINALIZED", gross: 1500 });
});

describe("statusCounts", () => {
  it("liefert je effektivem Status Anzahl und offenen Betrag in fester Reihenfolge", async () => {
    const rows = await statusCounts(orgId, NOW);
    expect(rows.map((r) => [r.status, r.count, r.openCents])).toEqual([
      ["DRAFT", 1, 0],
      ["FINALIZED", 1, 0],
      ["OPEN", 4, 11500],
      ["DUE", 1, 4000],
      ["OVERDUE", 2, 10000],
      ["PAID", 1, 0],
      ["CANCELLED", 2, 0],
    ]);
  });

  it("zaehlt nur die eigene Organisation, leere Organisation liefert keine Zeilen", async () => {
    expect(await statusCounts(emptyOrgId, NOW)).toEqual([]);
  });

  it("die Faelligkeit haengt vom Stichtag ab (Tag spaeter: heute faellige Rechnung ueberfaellig)", async () => {
    const rows = await statusCounts(orgId, new Date(Date.UTC(2331, 5, 16, 10, 0, 0)));
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, [r.count, r.openCents]]));
    expect(byStatus.DUE).toBeUndefined();
    expect(byStatus.OVERDUE).toEqual([3, 14000]);
    expect(byStatus.OPEN).toEqual([4 - 0, 11500]);
  });
});
