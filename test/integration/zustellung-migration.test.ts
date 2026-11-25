/** Zustellung und Alarme — Bestandsdaten-Migration (SQLite): Benachrichtigungstyp WEBHOOK_DEAD, Backfill alarmMailedAt, Eindeutigkeit InvoiceAutoSend. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261210090000_zustellung_alarme/migration.sql", "utf8");
const statements = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.startsWith("UPDATE"));
const typeUpdate = statements.filter((s) => s.startsWith('UPDATE "NotificationSettings"'));
const backfill = statements.filter((s) => s.startsWith('UPDATE "Notification" '));

const mkOrg = async (n: string) =>
  (await dbInternal.organization.create({ data: { legalName: `MigZ ${n}`, addressLine1: "x", postalCode: "1", city: "y" } })).id;

describe("Zustellung-Migration", () => {
  it("ergaenzt WEBHOOK_DEAD (auch bei [], nicht doppelt), zweimal ausgefuehrt identisch", async () => {
    expect(typeUpdate).toHaveLength(1);
    const [a, b, c] = [await mkOrg("a"), await mkOrg("b"), await mkOrg("c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: a, enabledTypesJson: '["INVOICE_OVERDUE"]' },
        { orgId: b, enabledTypesJson: "[]" },
        { orgId: c, enabledTypesJson: '["WEBHOOK_DEAD","INVOICE_OVERDUE"]' },
      ],
    });
    const read = async () => {
      const rows = await dbInternal.notificationSettings.findMany({
        where: { orgId: { in: [a, b, c] } },
        select: { orgId: true, enabledTypesJson: true },
      });
      return Object.fromEntries(rows.map((r) => [r.orgId, r.enabledTypesJson]));
    };
    await dbInternal.$executeRawUnsafe(typeUpdate[0]!);
    const once = await read();
    await dbInternal.$executeRawUnsafe(typeUpdate[0]!);
    expect(await read()).toEqual(once);
    expect(once[a]).toBe('["INVOICE_OVERDUE","WEBHOOK_DEAD"]');
    expect(once[b]).toBe('["WEBHOOK_DEAD"]');
    expect(once[c]).toBe('["WEBHOOK_DEAD","INVOICE_OVERDUE"]');
  });

  it("setzt alarmMailedAt bei Bestandsbenachrichtigungen auf createdAt; alarmEmail-Standard true", async () => {
    expect(backfill).toHaveLength(1);
    const org = await mkOrg("d");
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const n = await dbInternal.notification.create({
      data: { orgId: org, type: "SCHEDULER_FAILED", title: "t", dedupeKey: "migz-1", createdAt },
      select: { id: true, alarmMailedAt: true },
    });
    expect(n.alarmMailedAt).toBeNull();
    await dbInternal.$executeRawUnsafe(backfill[0]!);
    const after = await dbInternal.notification.findUniqueOrThrow({ where: { id: n.id }, select: { alarmMailedAt: true } });
    expect(after.alarmMailedAt?.toISOString()).toBe(createdAt.toISOString());
    const s = await dbInternal.notificationSettings.create({
      data: { orgId: org, enabledTypesJson: "[]" },
      select: { alarmEmail: true, lastAlarmMailAt: true },
    });
    expect(s).toEqual({ alarmEmail: true, lastAlarmMailAt: null });
  });

  it("InvoiceAutoSend: gleiche invoiceId zweimal -> P2002", async () => {
    const org = await mkOrg("e");
    await dbInternal.invoiceAutoSend.create({ data: { orgId: org, invoiceId: "inv-migz-1", status: "PENDING" } });
    await expect(
      dbInternal.invoiceAutoSend.create({ data: { orgId: org, invoiceId: "inv-migz-1", status: "PENDING" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
