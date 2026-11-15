/**
 * Schema DATEV-Export: Defaults, Unique-Regeln, Restrict-Fremdschluessel, Debitorennummer.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { ALL_NOTIFICATION_TYPES, isMandatoryNotificationType } from "@/domain/notifications/settings";

let orgId = "";
let otherOrgId = "";

function exportData(org: string) {
  return {
    orgId: org,
    mode: "PERIOD",
    fromMonth: "2096-01",
    toMonth: "2096-01",
    lineCount: 0,
    itemCount: 0,
    manualCount: 0,
    debtorCount: 0,
    sha256: "x",
    archivePath: "datev/x.zip",
    filesJson: "[]",
    settingsJson: "{}",
    createdBy: "test",
  };
}

function customer(org: string, name: string, datevAccount?: number) {
  return { orgId: org, name, addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt", datevAccount };
}

beforeAll(async () => {
  const mk = async (name: string) =>
    (
      await dbInternal.organization.create({
        data: { legalName: name, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
        select: { id: true },
      })
    ).id;
  orgId = await mk("Datev-Schema GmbH");
  otherOrgId = await mk("Datev-Schema Zwei GmbH");
});

describe("Schema DATEV", () => {
  it("Einstellungen mit Standardwerten, eine Zeile je Organisation", async () => {
    const s = await dbInternal.datevSettings.create({ data: { orgId }, select: { accountLength: true, debtorMode: true, lockBatch: true, exportPayments: true, exportDebtors: true, useGeneralReversal: true, fiscalYearStartMonth: true, confirmedHash: true } });
    expect(s).toEqual({
      accountLength: 4,
      debtorMode: "PERSONAL",
      lockBatch: false,
      exportPayments: false,
      exportDebtors: true,
      useGeneralReversal: true,
      fiscalYearStartMonth: 1,
      confirmedHash: null,
    });
    await expect(dbInternal.datevSettings.create({ data: { orgId }, select: { id: true } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("Kontenzuordnung: (orgId, kind, key) eindeutig", async () => {
    await dbInternal.datevAccountMapping.create({ data: { orgId, kind: "REVENUE", key: "REGULAR|S|19", account: 8400 }, select: { id: true } });
    await expect(
      dbInternal.datevAccountMapping.create({ data: { orgId, kind: "REVENUE", key: "REGULAR|S|19", account: 8401 }, select: { id: true } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await dbInternal.datevAccountMapping.create({ data: { orgId, kind: "DOWNPAYMENT", key: "REGULAR|S|19", account: 1710 }, select: { id: true } });
    await dbInternal.datevAccountMapping.create({ data: { orgId: otherOrgId, kind: "REVENUE", key: "REGULAR|S|19", account: 8400 }, select: { id: true } });
  });

  it("Debitorennummer: doppelt je Organisation P2002, zwei Organisationen und zwei NULL ok", async () => {
    await dbInternal.customer.create({ data: customer(orgId, "D1", 10001), select: { id: true } });
    await expect(dbInternal.customer.create({ data: customer(orgId, "D2", 10001), select: { id: true } })).rejects.toMatchObject({ code: "P2002" });
    await dbInternal.customer.create({ data: customer(otherOrgId, "D3", 10001), select: { id: true } });
    await dbInternal.customer.create({ data: customer(orgId, "N1"), select: { id: true } });
    await dbInternal.customer.create({ data: customer(orgId, "N2"), select: { id: true } });
  });

  it("Position ohne Export scheitert (P2003)", async () => {
    await expect(
      dbInternal.datevExportItem.create({
        data: { orgId, exportId: "gibt-es-nicht", itemKey: "INV:x", month: "2096-01", status: "EXPORTED", lineCount: 1, amountCents: 1 },
        select: { id: true },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("Export mit Positionen ist nicht loeschbar (Restrict)", async () => {
    const exp = await dbInternal.datevExport.create({ data: exportData(orgId), select: { id: true, repeat: true } });
    expect(exp.repeat).toBe(false);
    await dbInternal.datevExportItem.create({
      data: { orgId, exportId: exp.id, itemKey: "INV:y", month: "2096-01", status: "EXPORTED", lineCount: 1, amountCents: 1 },
      select: { id: true },
    });
    await expect(dbInternal.datevExport.delete({ where: { id: exp.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("Benachrichtigungstyp DATEV_LATE_ITEMS vorhanden, nicht Pflicht", () => {
    expect(ALL_NOTIFICATION_TYPES).toContain("DATEV_LATE_ITEMS");
    expect(isMandatoryNotificationType("DATEV_LATE_ITEMS")).toBe(false);
  });
});
