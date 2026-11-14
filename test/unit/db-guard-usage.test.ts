/**
 * Phase 18f — RecurringUsage-Guard: create erlaubt, update/delete ueber prisma verboten,
 * dbInternal darf. lockRow kennt RecurringInvoice (unter SQLite No-op).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal, prisma, RecurringUsageImmutabilityError } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";

let orgId = "";
let recurringId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Verbrauch-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Verbrauch-Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const rec = await dbInternal.recurringInvoice.create({
    data: { orgId, customerId: customer.id, title: "Abo Guard", startDate: new Date(), nextRunDate: new Date() },
    select: { id: true },
  });
  recurringId = rec.id;
});

function usageData(externalId: string) {
  const d = new Date("2185-01-10T00:00:00Z");
  return {
    orgId, recurringInvoiceId: recurringId, usageDate: d, periodStart: d, periodEnd: d,
    quantityMilli: 1000, source: "API", externalId, createdBy: "test",
  };
}

describe("RecurringUsage-Guard (Phase 18f)", () => {
  it("create ueber prisma erlaubt, update/updateMany/upsert/delete/deleteMany verboten", async () => {
    const row = await prisma.recurringUsage.create({ data: usageData("g-1"), select: { id: true } });
    await expect(prisma.recurringUsage.update({ where: { id: row.id }, data: { note: "x" } })).rejects.toBeInstanceOf(RecurringUsageImmutabilityError);
    await expect(prisma.recurringUsage.updateMany({ where: { id: row.id }, data: { note: "x" } })).rejects.toBeInstanceOf(RecurringUsageImmutabilityError);
    await expect(
      prisma.recurringUsage.upsert({ where: { id: row.id }, create: usageData("g-2"), update: { note: "x" } }),
    ).rejects.toBeInstanceOf(RecurringUsageImmutabilityError);
    await expect(prisma.recurringUsage.delete({ where: { id: row.id } })).rejects.toBeInstanceOf(RecurringUsageImmutabilityError);
    await expect(prisma.recurringUsage.deleteMany({ where: { orgId } })).rejects.toBeInstanceOf(RecurringUsageImmutabilityError);
    await expect(prisma.recurringUsage.update({ where: { id: row.id }, data: { note: "x" } })).rejects.toThrow(/unveraenderlich/);
  });

  it("dbInternal darf aendern (voidUsage-Pfad)", async () => {
    const row = await dbInternal.recurringUsage.create({ data: usageData("g-3"), select: { id: true } });
    const upd = await dbInternal.recurringUsage.update({ where: { id: row.id }, data: { voidReason: "Test" }, select: { voidReason: true } });
    expect(upd.voidReason).toBe("Test");
  });

  it("lockRow: RecurringInvoice erlaubt (SQLite No-op), unbekannte Tabelle wirft weiter", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const tx = { $queryRawUnsafe: fn } as unknown as Prisma.TransactionClient;
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "file:./x.db";
    try {
      await lockRow(tx, "RecurringInvoice", recurringId, orgId);
      expect(fn).not.toHaveBeenCalled();
      await expect(lockRow(tx, "User" as never, "a", orgId)).rejects.toThrow();
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});
