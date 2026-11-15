/**
 * Guard DATEV-Export: Exportprotokolle append-only, Einstellungen nicht loeschbar.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma, DatevExportImmutableError, DatevSettingsDeleteError } from "@/lib/db";

let orgId = "";
let exportId = "";
let itemId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Datev-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const exp = await prisma.datevExport.create({
    data: {
      orgId,
      mode: "PERIOD",
      fromMonth: "2096-01",
      toMonth: "2096-01",
      lineCount: 0,
      itemCount: 0,
      manualCount: 0,
      debtorCount: 0,
      sha256: "guard-sha",
      archivePath: "datev/guard.zip",
      filesJson: "[]",
      settingsJson: "{}",
      createdBy: "test",
    },
    select: { id: true },
  });
  exportId = exp.id;
  const item = await prisma.datevExportItem.create({
    data: { orgId, exportId, itemKey: "INV:guard", month: "2096-01", status: "EXPORTED", lineCount: 1, amountCents: 100 },
    select: { id: true },
  });
  itemId = item.id;
  await prisma.datevSettings.create({ data: { orgId }, select: { id: true } });
});

describe("Guard DATEV-Protokolle", () => {
  const ops = ["update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"] as const;

  for (const op of ops) {
    it(`datevExport.${op} wirft`, async () => {
      const args = {
        where: { id: exportId },
        data: { lineCount: 5 },
        create: {},
        update: {},
      } as never;
      const fn = (prisma.datevExport as unknown as Record<string, (a: unknown) => Promise<unknown>>)[op];
      await expect(fn(args)).rejects.toBeInstanceOf(DatevExportImmutableError);
    });
    it(`datevExportItem.${op} wirft`, async () => {
      const args = { where: { id: itemId }, data: { lineCount: 5 }, create: {}, update: {} } as never;
      const fn = (prisma.datevExportItem as unknown as Record<string, (a: unknown) => Promise<unknown>>)[op];
      await expect(fn(args)).rejects.toBeInstanceOf(DatevExportImmutableError);
    });
  }

  it("wirft auch im Transaktionsclient", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.datevExportItem.update({ where: { id: itemId }, data: { lineCount: 9 } });
      }),
    ).rejects.toBeInstanceOf(DatevExportImmutableError);
  });

  it("create bleibt erlaubt", async () => {
    const item = await prisma.datevExportItem.create({
      data: { orgId, exportId, itemKey: "INV:guard2", month: "2096-01", status: "EMPTY", lineCount: 0, amountCents: 0 },
      select: { id: true },
    });
    expect(item.id).toBeTruthy();
  });

  it("Einstellungen sind nicht loeschbar, aenderbar", async () => {
    await expect(prisma.datevSettings.delete({ where: { orgId } })).rejects.toBeInstanceOf(DatevSettingsDeleteError);
    await expect(prisma.datevSettings.deleteMany({ where: { orgId } })).rejects.toBeInstanceOf(DatevSettingsDeleteError);
    const upd = await prisma.datevSettings.update({ where: { orgId }, data: { accountLength: 5 }, select: { accountLength: true } });
    expect(upd.accountLength).toBe(5);
  });
});
