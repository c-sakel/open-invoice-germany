/**
 * Eingangsrechnungen Arbeitsablauf: neue Spalten, Aenderungsschutz, Faelligkeit bei der Annahme. Testjahr 2240.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal, prisma, IncomingInvoiceImmutableError } from "@/lib/db";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { ALL_NOTIFICATION_TYPES, NOTIFICATION_TYPES, isMandatoryNotificationType } from "@/domain/notifications/settings";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const NOW = new Date("2240-03-01T10:00:00.000Z");

let tmp = "";
let prevDir: string | undefined;
let orgId = "";
let invId = "";

const base = (sha: string) => ({
  orgId,
  receivedAt: new Date("2240-03-01T10:00:00.000Z"),
  channel: "UPLOAD",
  originalFileName: "rechnung.xml",
  originalMime: "application/xml",
  originalSize: 100,
  originalSha256: sha,
  originalPath: `incoming/${sha}`,
  kind: "EINVOICE",
  createdBy: "test",
});

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-ablauf-schema-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  const org = await dbInternal.organization.create({
    data: { legalName: "Eingang Ablauf Schema GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const inv = await dbInternal.incomingInvoice.create({ data: base("c".repeat(64)), select: { id: true } });
  invId = inv.id;
});

afterAll(async () => {
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("Ablauf-Spalten", () => {
  it("sind standardmaessig NULL", async () => {
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({
      where: { id: invId },
      select: {
        supplierContactId: true, internalNote: true, manualJson: true, dueAt: true, checkedAt: true, checkedBy: true,
        approvedAt: true, approvedBy: true, rejectedAt: true, rejectedBy: true, rejectReason: true, paidMarkedAt: true, paidNote: true,
      },
    });
    expect(Object.values(row).every((v) => v === null)).toBe(true);
    expect(Object.keys(row)).toHaveLength(13);
  });

  it("sind aenderbar (update und updateMany)", async () => {
    const at = new Date("2240-03-02T08:00:00.000Z");
    await prisma.incomingInvoice.update({
      where: { id: invId },
      data: {
        supplierContactId: "k1", internalNote: "n", manualJson: "{}", dueAt: at, checkedAt: at, checkedBy: "u", approvedAt: at,
        approvedBy: "u", rejectedAt: at, rejectedBy: "u", rejectReason: "grund", paidMarkedAt: at, paidNote: "p",
      },
    });
    await prisma.incomingInvoice.updateMany({ where: { id: invId }, data: { internalNote: null, paidNote: null, dueAt: null } });
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({
      where: { id: invId },
      select: { supplierContactId: true, internalNote: true, dueAt: true, checkedBy: true },
    });
    expect(row).toEqual({ supplierContactId: "k1", internalNote: null, dueAt: null, checkedBy: "u" });
  });

  for (const key of ["number", "dueDate", "grossCents", "originalSha256", "supplierName", "receivedAt", "orgId"] as const) {
    it(`${key} bleibt gesperrt`, async () => {
      const data = { [key]: key === "receivedAt" || key === "dueDate" ? new Date() : key === "grossCents" ? 1 : "x" } as never;
      await expect(prisma.incomingInvoice.update({ where: { id: invId }, data })).rejects.toThrow(IncomingInvoiceImmutableError);
      await expect(prisma.incomingInvoice.updateMany({ where: { id: invId }, data })).rejects.toThrow(IncomingInvoiceImmutableError);
    });
  }

  it("Loeschen und upsert bleiben gesperrt", async () => {
    await expect(prisma.incomingInvoice.delete({ where: { id: invId } })).rejects.toThrow(IncomingInvoiceImmutableError);
    await expect(prisma.incomingInvoice.deleteMany({ where: { id: invId } })).rejects.toThrow(IncomingInvoiceImmutableError);
    await expect(
      prisma.incomingInvoice.upsert({ where: { id: invId }, create: base("d".repeat(64)), update: { status: "NEW" } }),
    ).rejects.toThrow(IncomingInvoiceImmutableError);
  });
});

describe("Faelligkeit bei der Annahme", () => {
  it("dueAt = BT-9 aus der Datei", async () => {
    const res = await receiveIncomingInvoice(orgId, fx("gen-base-ubl.xml"), { fileName: "a.xml", channel: "UPLOAD", actor: "tester", now: NOW });
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { dueDate: true, dueAt: true } });
    expect(row.dueDate).not.toBeNull();
    expect(row.dueAt?.toISOString()).toBe(row.dueDate?.toISOString());
  });

  it("ohne Kopfdaten (PNG) bleibt dueAt NULL", async () => {
    const res = await receiveIncomingInvoice(orgId, PNG, { fileName: "scan.png", channel: "UPLOAD", actor: "tester", now: NOW });
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { dueAt: true } });
    expect(row.dueAt).toBeNull();
  });
});

describe("Benachrichtigungstyp und Migration", () => {
  it("INCOMING_DUE vorhanden und kein Pflichttyp", () => {
    expect(NOTIFICATION_TYPES.INCOMING_DUE).toBe("Eingangsrechnung faellig");
    expect(ALL_NOTIFICATION_TYPES).toContain("INCOMING_DUE");
    expect(isMandatoryNotificationType("INCOMING_DUE")).toBe(false);
  });

  it("SQLite-Migration ist additiv", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../prisma/migrations/20261130090000_eingang_ablauf/migration.sql"), "utf8");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toContain('CREATE TABLE "new_');
    const pg = fs.readFileSync(path.resolve(__dirname, "../../prisma/migrations-postgres/20261130090100_eingang_ablauf/migration.sql"), "utf8");
    expect(pg).not.toMatch(/\bDROP\b/i);
  });
});
