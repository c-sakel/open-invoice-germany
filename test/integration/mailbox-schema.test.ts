/**
 * Postfach-Abruf: Tabellen, Standardwerte, Aenderungsschutz, Benachrichtigungstypen, Migration. Testjahr 2245.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { dbInternal, prisma, InboundMailAttachmentImmutableError, InboundMailMessageImmutableError } from "@/lib/db";
import { ALL_NOTIFICATION_TYPES, NOTIFICATION_TYPES, isMandatoryNotificationType } from "@/domain/notifications/settings";
import { INBOUND_MAIL_PASSWORD_PURPOSE } from "@/lib/crypto/secrets";

const FETCHED = new Date("2245-03-01T10:00:00.000Z");
const mig = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const SQLITE_MIG = "prisma/migrations/20261201090000_eingang_postfach/migration.sql";
const PG_MIG = "prisma/migrations-postgres/20261201090100_eingang_postfach/migration.sql";

let orgId = "";
let msgId = "";
let attId = "";
let n = 0;

const msgData = (uid: string) => ({
  orgId,
  accountKey: "a".repeat(32),
  uidValidity: "1700000000",
  uid,
  fetchedAt: FETCHED,
  size: 1234,
  result: "STAGED",
  subject: "Rechnung 2245",
});

const attData = (messageId: string, partIndex: number) => ({
  orgId,
  messageId,
  partIndex,
  fileName: "rechnung.xml",
  mime: "application/xml",
  size: 100,
  sha256: `${partIndex}`.padStart(64, "b"),
  status: "INBOX",
  stagingPath: `mail-inbox/${orgId}/x.xml`,
});

const newOrg = async (name: string) =>
  (await dbInternal.organization.create({ data: { legalName: `Postfach ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;

beforeAll(async () => {
  orgId = await newOrg("Schema");
  msgId = (await dbInternal.inboundMailMessage.create({ data: msgData("1"), select: { id: true } })).id;
  attId = (await dbInternal.inboundMailAttachment.create({ data: attData(msgId, 0), select: { id: true } })).id;
});

describe("Einstellungen", () => {
  it("Standard: aus, Port 993, TLS, Ordner INBOX, keine Absenderfilter", async () => {
    const id = await newOrg("Defaults");
    const row = await dbInternal.inboundMailboxSettings.create({
      data: { orgId: id },
      select: { enabled: true, port: true, security: true, folder: true, allowedSenderDomainsJson: true, host: true, passwordEnc: true, lastRunFetched: true, fetchSince: true },
    });
    expect(row).toEqual({ enabled: false, port: 993, security: "TLS", folder: "INBOX", allowedSenderDomainsJson: "[]", host: null, passwordEnc: null, lastRunFetched: 0, fetchSince: null });
  });

  it("je Firma genau eine Zeile", async () => {
    const id = await newOrg("Einmalig");
    await dbInternal.inboundMailboxSettings.create({ data: { orgId: id } });
    await expect(dbInternal.inboundMailboxSettings.create({ data: { orgId: id } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("Passwort-Verwendungszweck ist festgelegt", () => {
    expect(INBOUND_MAIL_PASSWORD_PURPOSE).toBe("oig-imap-v1");
  });
});

describe("Abrufprotokoll", () => {
  it("zweite Zeile mit gleichem (orgId, accountKey, uidValidity, uid) scheitert", async () => {
    await expect(dbInternal.inboundMailMessage.create({ data: msgData("1") })).rejects.toMatchObject({ code: "P2002" });
    await dbInternal.inboundMailMessage.create({ data: msgData("2") });
  });

  it("nur der Betreff darf geleert werden (update und updateMany)", async () => {
    const id = (await dbInternal.inboundMailMessage.create({ data: msgData("3"), select: { id: true } })).id;
    await prisma.inboundMailMessage.update({ where: { id }, data: { subject: null } });
    const row = await dbInternal.inboundMailMessage.findUniqueOrThrow({ where: { id }, select: { subject: true } });
    expect(row.subject).toBeNull();
    const id2 = (await dbInternal.inboundMailMessage.create({ data: msgData("4"), select: { id: true } })).id;
    await prisma.inboundMailMessage.updateMany({ where: { id: id2 }, data: { subject: { set: null } } });
    expect((await dbInternal.inboundMailMessage.findUniqueOrThrow({ where: { id: id2 }, select: { subject: true } })).subject).toBeNull();
  });

  it("anderer Betreff, Ergebnis und UID sind gesperrt", async () => {
    for (const data of [{ subject: "x" }, { result: "TOO_LARGE" }, { uid: "99" }, { size: 1 }, { subject: null, result: "x" }]) {
      await expect(prisma.inboundMailMessage.update({ where: { id: msgId }, data: data as never })).rejects.toThrow(InboundMailMessageImmutableError);
      await expect(prisma.inboundMailMessage.updateMany({ where: { id: msgId }, data: data as never })).rejects.toThrow(InboundMailMessageImmutableError);
    }
    const row = await dbInternal.inboundMailMessage.findUniqueOrThrow({ where: { id: msgId }, select: { subject: true, result: true, uid: true, size: true } });
    expect(row).toEqual({ subject: "Rechnung 2245", result: "STAGED", uid: "1", size: 1234 });
  });

  it("delete, deleteMany und upsert sind gesperrt", async () => {
    await expect(prisma.inboundMailMessage.delete({ where: { id: msgId } })).rejects.toThrow(InboundMailMessageImmutableError);
    await expect(prisma.inboundMailMessage.deleteMany({ where: { id: msgId } })).rejects.toThrow(InboundMailMessageImmutableError);
    await expect(
      prisma.inboundMailMessage.upsert({ where: { id: msgId }, create: msgData("77"), update: { subject: null } }),
    ).rejects.toThrow(InboundMailMessageImmutableError);
  });

  it("Protokollzeile mit Anlage ist per Roh-SQL nicht loeschbar (Fremdschluessel)", async () => {
    await expect(dbInternal.$executeRawUnsafe(`DELETE FROM "InboundMailMessage" WHERE "id" = '${msgId}'`)).rejects.toThrow();
    expect(await dbInternal.inboundMailMessage.count({ where: { id: msgId } })).toBe(1);
  });
});

describe("Anlagen", () => {
  it("Standardwerte: nur Pflichtfelder gesetzt, Entscheidungsfelder NULL", async () => {
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({
      where: { id: attId },
      select: { incomingInvoiceId: true, decidedAt: true, decidedBy: true, discardReason: true, purgedAt: true, skipReason: true, previewJson: true },
    });
    expect(Object.values(row).every((v) => v === null)).toBe(true);
  });

  it("Positivliste ist aenderbar", async () => {
    const id = (await dbInternal.inboundMailAttachment.create({ data: attData(msgId, ++n + 10), select: { id: true } })).id;
    const at = new Date("2245-03-02T08:00:00.000Z");
    await prisma.inboundMailAttachment.update({
      where: { id },
      data: { status: "DISCARDED", decidedAt: at, decidedBy: "u", discardReason: "Werbung", duplicateOfIncomingId: "x", purgedAt: at, stagingPath: null },
    });
    await prisma.inboundMailAttachment.updateMany({ where: { id }, data: { status: "INBOX", discardReason: null, decidedAt: null } });
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id }, select: { status: true, decidedBy: true, stagingPath: true, discardReason: true } });
    expect(row).toEqual({ status: "INBOX", decidedBy: "u", stagingPath: null, discardReason: null });
  });

  it("Dateiangaben und Zuordnung zur Mail sind gesperrt", async () => {
    for (const data of [{ sha256: "x" }, { fileName: "y" }, { size: 1 }, { messageId: "z" }, { mime: "a/b" }, { partIndex: 9 }, { previewJson: "{}" }]) {
      await expect(prisma.inboundMailAttachment.update({ where: { id: attId }, data: data as never })).rejects.toThrow(InboundMailAttachmentImmutableError);
      await expect(prisma.inboundMailAttachment.updateMany({ where: { id: attId }, data: data as never })).rejects.toThrow(InboundMailAttachmentImmutableError);
    }
  });

  it("der Pfad der Zwischenablage darf nur geleert werden", async () => {
    await expect(prisma.inboundMailAttachment.update({ where: { id: attId }, data: { stagingPath: "x" } })).rejects.toThrow(InboundMailAttachmentImmutableError);
    await expect(prisma.inboundMailAttachment.updateMany({ where: { id: attId }, data: { stagingPath: { set: "x" } } })).rejects.toThrow(InboundMailAttachmentImmutableError);
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: attId }, select: { stagingPath: true } });
    expect(row.stagingPath).toBe(`mail-inbox/${orgId}/x.xml`);
  });

  it("delete, deleteMany und upsert sind gesperrt", async () => {
    await expect(prisma.inboundMailAttachment.delete({ where: { id: attId } })).rejects.toThrow(InboundMailAttachmentImmutableError);
    await expect(prisma.inboundMailAttachment.deleteMany({ where: { id: attId } })).rejects.toThrow(InboundMailAttachmentImmutableError);
    await expect(
      prisma.inboundMailAttachment.upsert({ where: { id: attId }, create: attData(msgId, 500), update: { status: "INBOX" } }),
    ).rejects.toThrow(InboundMailAttachmentImmutableError);
  });

  it("(messageId, partIndex) ist eindeutig", async () => {
    await expect(dbInternal.inboundMailAttachment.create({ data: attData(msgId, 0) })).rejects.toMatchObject({ code: "P2002" });
  });

  it("zwei Anlagen koennen nicht dieselbe Eingangsrechnung belegen", async () => {
    const inv = await dbInternal.incomingInvoice.create({
      data: {
        orgId,
        receivedAt: FETCHED,
        channel: "MAILBOX",
        originalFileName: "r.xml",
        originalMime: "application/xml",
        originalSize: 10,
        originalSha256: "c".repeat(64),
        originalPath: "incoming/c",
        kind: "EINVOICE",
        createdBy: "test",
      },
      select: { id: true },
    });
    const a = (await dbInternal.inboundMailAttachment.create({ data: attData(msgId, 600), select: { id: true } })).id;
    const b = (await dbInternal.inboundMailAttachment.create({ data: attData(msgId, 601), select: { id: true } })).id;
    await prisma.inboundMailAttachment.update({ where: { id: a }, data: { incomingInvoiceId: inv.id, status: "ACCEPTED" } });
    await expect(prisma.inboundMailAttachment.update({ where: { id: b }, data: { incomingInvoiceId: inv.id } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("Benachrichtigungstypen", () => {
  it("sind vorhanden und keine Pflichttypen", () => {
    expect(NOTIFICATION_TYPES.INBOUND_MAIL_NEW).toBe("Neue Belege im Postfach");
    expect(NOTIFICATION_TYPES.INBOUND_MAIL_ERROR).toBe("Postfach-Abruf gestört");
    for (const t of ["INBOUND_MAIL_NEW", "INBOUND_MAIL_ERROR"] as const) {
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
    expect(sqlite).not.toMatch(/ALTER TABLE/i);
    expect((sqlite.match(/CREATE TABLE/g) ?? []).length).toBe(3);
    const pg = mig(PG_MIG);
    expect(pg).not.toMatch(/\bDROP\b/i);
    expect((pg.match(/CREATE TABLE/g) ?? []).length).toBe(3);
    expect(pg).toContain('"fetchedAt" TIMESTAMP(3) NOT NULL');
  });

  it("Bestands-UPDATE ergaenzt beide Typen genau einmal (idempotent)", async () => {
    const sql = mig(SQLITE_MIG);
    const start = sql.indexOf('UPDATE "NotificationSettings"');
    const stmts = sql
      .slice(start)
      .split(/;\s*\n/)
      .map((s) => s.trim().replace(/;$/, ""))
      .filter((s) => s.startsWith("UPDATE") || s.startsWith("-- ") === false && s.includes("UPDATE"))
      .map((s) => s.slice(s.indexOf("UPDATE")));
    expect(stmts).toHaveLength(2);
    const ids = [await newOrg("Mig a"), await newOrg("Mig b"), await newOrg("Mig c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: ids[0], enabledTypesJson: '["INVOICE_OVERDUE","INCOMING_DUE"]' },
        { orgId: ids[1], enabledTypesJson: "[]" },
        { orgId: ids[2], enabledTypesJson: '["INBOUND_MAIL_NEW","INBOUND_MAIL_ERROR"]' },
      ],
    });
    for (let i = 0; i < 2; i++) for (const s of stmts) await dbInternal.$executeRawUnsafe(s);
    const rows = await dbInternal.notificationSettings.findMany({ where: { orgId: { in: ids } }, select: { orgId: true, enabledTypesJson: true } });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, JSON.parse(r.enabledTypesJson) as string[]]));
    expect(by[ids[0]]).toEqual(["INVOICE_OVERDUE", "INCOMING_DUE", "INBOUND_MAIL_NEW", "INBOUND_MAIL_ERROR"]);
    expect(by[ids[1]]).toEqual(["INBOUND_MAIL_NEW", "INBOUND_MAIL_ERROR"]);
    expect(by[ids[2]]).toEqual(["INBOUND_MAIL_NEW", "INBOUND_MAIL_ERROR"]);
  });
});
