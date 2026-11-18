/**
 * Kontoabruf: Tabellen, Standardwerte, Aenderungsschutz, Benachrichtigungstypen, Migration. Testjahr 2250.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  dbInternal,
  prisma,
  BankConnectionAccountImmutableError,
  BankConnectionDeleteError,
  BankFetchRunImmutableError,
} from "@/lib/db";
import { ALL_NOTIFICATION_TYPES, NOTIFICATION_TYPES, isMandatoryNotificationType } from "@/domain/notifications/settings";
import { FINTS_PIN_PURPOSE, FINTS_PIN_REJECT_PURPOSE } from "@/lib/crypto/secrets";

const AT = new Date("2250-03-01T10:00:00.000Z");
const IBAN = "DE89370400440532013000";
const mig = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const SQLITE_MIG = "prisma/migrations/20261205090000_kontoabruf/migration.sql";
const PG_MIG = "prisma/migrations-postgres/20261205090100_kontoabruf/migration.sql";

let orgId = "";
let connId = "";
let accId = "";
let runId = "";

const newOrg = async (name: string) =>
  (await dbInternal.organization.create({ data: { legalName: `Kontoabruf ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;

const newConn = (org: string, label = "Testzugang") =>
  dbInternal.bankConnection.create({
    data: { orgId: org, label, bankCode: "37040044", url: "https://fints.example.org/fints", userId: "kunde4711" },
    select: { id: true },
  });

beforeAll(async () => {
  orgId = await newOrg("Schema");
  connId = (await newConn(orgId)).id;
  accId = (await dbInternal.bankConnectionAccount.create({ data: { orgId, connectionId: connId, iban: IBAN }, select: { id: true } })).id;
  runId = (
    await dbInternal.bankFetchRun.create({
      data: { orgId, connectionId: connId, accountId: accId, trigger: "MANUAL", startedAt: AT, finishedAt: AT, result: "OK", actor: "test" },
      select: { id: true },
    })
  ).id;
});

describe("Standardwerte", () => {
  it("Einstellungen: Produkt-ID leer, 6 Uhr, 30 Tage, je Firma genau eine Zeile", async () => {
    const id = await newOrg("Defaults");
    const row = await dbInternal.bankFetchSettings.create({ data: { orgId: id }, select: { productId: true, autoHour: true, firstFetchDays: true } });
    expect(row).toEqual({ productId: null, autoHour: 6, firstFetchDays: 30 });
    await expect(dbInternal.bankFetchSettings.create({ data: { orgId: id } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("Bankzugang: PIN je Abruf, Status NEW, Automatik aus, keine Zugangsdaten", async () => {
    const row = await dbInternal.bankConnection.findUniqueOrThrow({
      where: { id: connId },
      select: { pinMode: true, state: true, autoEnabled: true, pinEnc: true, rejectedPinHmac: true, authFailures: true, transientFailuresToday: true, leaseUntil: true, nextAutoAt: true },
    });
    expect(row).toEqual({ pinMode: "PER_FETCH", state: "NEW", autoEnabled: false, pinEnc: null, rejectedPinHmac: null, authFailures: 0, transientFailuresToday: 0, leaseUntil: null, nextAutoAt: null });
  });

  it("Konto: nicht ausgewaehlt, ohne CAMT-Unterstuetzung; Protokoll mit Nullzaehlern", async () => {
    const acc = await dbInternal.bankConnectionAccount.findUniqueOrThrow({ where: { id: accId }, select: { selected: true, camtSupported: true, lastFetchedTo: true } });
    expect(acc).toEqual({ selected: false, camtSupported: false, lastFetchedTo: null });
    const run = await dbInternal.bankFetchRun.findUniqueOrThrow({ where: { id: runId }, select: { documents: true, bytes: true, importedCount: true, duplicateCount: true, scaUsed: true, importId: true } });
    expect(run).toEqual({ documents: 0, bytes: 0, importedCount: 0, duplicateCount: 0, scaUsed: false, importId: null });
  });

  it("Import: Herkunft ist UPLOAD, wenn nichts angegeben wird", async () => {
    const imp = await dbInternal.bankStatementImport.create({
      data: { orgId, fileSha256: "e".repeat(64), format: "CAMT053", schemaVersion: "camt.053.001.08", entryCount: 0, importedCount: 0, duplicateCount: 0, skippedCount: 0, createdBy: "test" },
      select: { origin: true },
    });
    expect(imp.origin).toBe("UPLOAD");
    const fints = await dbInternal.bankStatementImport.create({
      data: { orgId, fileSha256: "f".repeat(64), format: "CAMT052", schemaVersion: "camt.052.001.08", entryCount: 0, importedCount: 0, duplicateCount: 0, skippedCount: 0, createdBy: "test", origin: "FINTS" },
      select: { origin: true },
    });
    expect(fints.origin).toBe("FINTS");
  });

  it("Verwendungszwecke fuer PIN und Ablehnungspruefsumme sind festgelegt", () => {
    expect(FINTS_PIN_PURPOSE).toBe("oig-fints-pin-v1");
    expect(FINTS_PIN_REJECT_PURPOSE).toBe("oig-fints-pin-reject-v1");
  });
});

describe("Abrufprotokoll", () => {
  it("update, updateMany, upsert, delete und deleteMany sind gesperrt", async () => {
    await expect(prisma.bankFetchRun.update({ where: { id: runId }, data: { result: "X" } })).rejects.toThrow(BankFetchRunImmutableError);
    await expect(prisma.bankFetchRun.updateMany({ where: { id: runId }, data: { result: "X" } })).rejects.toThrow(BankFetchRunImmutableError);
    await expect(
      prisma.bankFetchRun.upsert({ where: { id: runId }, create: { orgId, connectionId: connId, trigger: "AUTO", startedAt: AT, finishedAt: AT, result: "OK", actor: "t" }, update: { result: "X" } }),
    ).rejects.toThrow(BankFetchRunImmutableError);
    await expect(prisma.bankFetchRun.delete({ where: { id: runId } })).rejects.toThrow(BankFetchRunImmutableError);
    await expect(prisma.bankFetchRun.deleteMany({ where: { id: runId } })).rejects.toThrow(BankFetchRunImmutableError);
    expect((await dbInternal.bankFetchRun.findUniqueOrThrow({ where: { id: runId }, select: { result: true } })).result).toBe("OK");
  });
});

describe("Konten und Bankzugaenge", () => {
  it("IBAN, Bankzugang und Firma sind gesperrt, die Auswahl ist aenderbar", async () => {
    for (const data of [{ iban: "DE00" }, { connectionId: "x" }, { orgId: "x" }]) {
      await expect(prisma.bankConnectionAccount.update({ where: { id: accId }, data: data as never })).rejects.toThrow(BankConnectionAccountImmutableError);
      await expect(prisma.bankConnectionAccount.updateMany({ where: { id: accId }, data: data as never })).rejects.toThrow(BankConnectionAccountImmutableError);
    }
    await prisma.bankConnectionAccount.update({ where: { id: accId }, data: { selected: true, lastFetchedTo: AT, camtSupported: true } });
    const row = await dbInternal.bankConnectionAccount.findUniqueOrThrow({ where: { id: accId }, select: { iban: true, selected: true, camtSupported: true } });
    expect(row).toEqual({ iban: IBAN, selected: true, camtSupported: true });
  });

  it("Konto loeschen und upsert sind gesperrt", async () => {
    await expect(prisma.bankConnectionAccount.delete({ where: { id: accId } })).rejects.toThrow(BankConnectionAccountImmutableError);
    await expect(prisma.bankConnectionAccount.deleteMany({ where: { id: accId } })).rejects.toThrow(BankConnectionAccountImmutableError);
    await expect(
      prisma.bankConnectionAccount.upsert({ where: { id: accId }, create: { orgId, connectionId: connId, iban: "DE00" }, update: { selected: false } }),
    ).rejects.toThrow(BankConnectionAccountImmutableError);
  });

  it("Bankzugang loeschen ist gesperrt, Aendern und Archivieren bleiben moeglich", async () => {
    await expect(prisma.bankConnection.delete({ where: { id: connId } })).rejects.toThrow(BankConnectionDeleteError);
    await expect(prisma.bankConnection.deleteMany({ where: { id: connId } })).rejects.toThrow(BankConnectionDeleteError);
    const id = (await newConn(orgId, "Archivtest")).id;
    await prisma.bankConnection.update({ where: { id }, data: { state: "ARCHIVED", archivedAt: AT, autoEnabled: false } });
    expect((await dbInternal.bankConnection.findUniqueOrThrow({ where: { id }, select: { state: true } })).state).toBe("ARCHIVED");
  });

  it("zweites Konto mit gleicher (connectionId, iban) scheitert, gleiche IBAN an anderem Zugang geht", async () => {
    await expect(dbInternal.bankConnectionAccount.create({ data: { orgId, connectionId: connId, iban: IBAN } })).rejects.toMatchObject({ code: "P2002" });
    const other = (await newConn(orgId, "Zweiter Zugang")).id;
    await dbInternal.bankConnectionAccount.create({ data: { orgId, connectionId: other, iban: IBAN } });
  });

  it("Fremdschluessel Restrict: Bankzugang, Konto und Import mit Protokoll sind per Roh-SQL nicht loeschbar", async () => {
    await expect(dbInternal.$executeRawUnsafe(`DELETE FROM "BankConnection" WHERE "id" = '${connId}'`)).rejects.toThrow();
    await expect(dbInternal.$executeRawUnsafe(`DELETE FROM "BankConnectionAccount" WHERE "id" = '${accId}'`)).rejects.toThrow();
    const imp = await dbInternal.bankStatementImport.create({
      data: { orgId, fileSha256: "d".repeat(64), format: "CAMT052", schemaVersion: "camt.052.001.08", entryCount: 0, importedCount: 0, duplicateCount: 0, skippedCount: 0, createdBy: "test", origin: "FINTS" },
      select: { id: true },
    });
    await dbInternal.bankFetchRun.create({ data: { orgId, connectionId: connId, accountId: accId, importId: imp.id, trigger: "AUTO", startedAt: AT, finishedAt: AT, result: "OK", actor: "job" } });
    await expect(dbInternal.$executeRawUnsafe(`DELETE FROM "BankStatementImport" WHERE "id" = '${imp.id}'`)).rejects.toThrow();
    expect(await dbInternal.bankConnection.count({ where: { id: connId } })).toBe(1);
  });
});

describe("Benachrichtigungstypen", () => {
  it("sind vorhanden und keine Pflichttypen", () => {
    expect(NOTIFICATION_TYPES.BANK_FETCH_ACTION).toBe("Kontoabruf braucht Ihre Freigabe");
    expect(NOTIFICATION_TYPES.BANK_FETCH_ERROR).toBe("Kontoabruf gestört");
    for (const t of ["BANK_FETCH_ACTION", "BANK_FETCH_ERROR"] as const) {
      expect(ALL_NOTIFICATION_TYPES).toContain(t);
      expect(isMandatoryNotificationType(t)).toBe(false);
    }
  });
});

describe("Migration", () => {
  it("SQLite und Postgres sind additiv", () => {
    const sqlite = mig(SQLITE_MIG);
    expect(sqlite).not.toMatch(/\bDROP\b/i);
    expect(sqlite).not.toContain('CREATE TABLE "new_');
    expect((sqlite.match(/CREATE TABLE/g) ?? []).length).toBe(4);
    expect(sqlite).toContain('ALTER TABLE "BankStatementImport" ADD COLUMN "origin" TEXT NOT NULL DEFAULT \'UPLOAD\'');
    const pg = mig(PG_MIG);
    expect(pg).not.toMatch(/\bDROP\b/i);
    expect((pg.match(/CREATE TABLE/g) ?? []).length).toBe(4);
    expect(pg).toContain('"startedAt" TIMESTAMP(3) NOT NULL');
    expect(pg).toContain("DEFAULT 'UPLOAD'");
  });

  it("Bestands-UPDATE ergaenzt beide Typen genau einmal (idempotent)", async () => {
    const sql = mig(SQLITE_MIG);
    const stmts = sql
      .slice(sql.indexOf('UPDATE "NotificationSettings"'))
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.includes("UPDATE"))
      .map((s) => s.slice(s.indexOf("UPDATE")));
    expect(stmts).toHaveLength(2);
    const ids = [await newOrg("Mig a"), await newOrg("Mig b"), await newOrg("Mig c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: ids[0], enabledTypesJson: '["INVOICE_OVERDUE","INCOMING_DUE"]' },
        { orgId: ids[1], enabledTypesJson: "[]" },
        { orgId: ids[2], enabledTypesJson: '["BANK_FETCH_ACTION","BANK_FETCH_ERROR"]' },
      ],
    });
    for (let i = 0; i < 2; i++) for (const s of stmts) await dbInternal.$executeRawUnsafe(s);
    const rows = await dbInternal.notificationSettings.findMany({ where: { orgId: { in: ids } }, select: { orgId: true, enabledTypesJson: true } });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, JSON.parse(r.enabledTypesJson) as string[]]));
    expect(by[ids[0]]).toEqual(["INVOICE_OVERDUE", "INCOMING_DUE", "BANK_FETCH_ACTION", "BANK_FETCH_ERROR"]);
    expect(by[ids[1]]).toEqual(["BANK_FETCH_ACTION", "BANK_FETCH_ERROR"]);
    expect(by[ids[2]]).toEqual(["BANK_FETCH_ACTION", "BANK_FETCH_ERROR"]);
  });
});
