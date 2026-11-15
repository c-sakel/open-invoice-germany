/** Bestandsdaten-Migration Zahlungsanbieter (SQLite): Zahlungsart ONLINE und Benachrichtigungstypen, idempotent. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261125090000_zahlungsanbieter/migration.sql", "utf8");
const statements = (prefix: string): string[] =>
  sql
    .split(";")
    .map((s) => s.replace(/^(\s*--[^\n]*\n)+/g, "").trim())
    .filter((s) => s.startsWith(prefix));
const insert = statements('INSERT INTO "PaymentMethod"');
const updates = statements('UPDATE "NotificationSettings"');

const mkOrg = async (n: string): Promise<string> =>
  (await dbInternal.organization.create({ data: { legalName: `MigO ${n}`, addressLine1: "x", postalCode: "1", city: "y" }, select: { id: true } })).id;

describe("Migration Zahlungsanbieter", () => {
  it("zieht die Zahlungsart ONLINE nach, ohne vorhandene zu duplizieren oder zu aendern, idempotent", async () => {
    expect(insert).toHaveLength(1);
    const a = await mkOrg("a");
    const b = await mkOrg("b");
    await dbInternal.paymentMethod.create({ data: { orgId: b, code: "ONLINE", name: "Eigene Online-Art", untdidCode: "ZZZ", isSystem: false } });
    for (let i = 0; i < 2; i++) await dbInternal.$executeRawUnsafe(insert[0]);
    const rows = await dbInternal.paymentMethod.findMany({
      where: { orgId: { in: [a, b] }, code: "ONLINE" },
      select: { orgId: true, name: true, untdidCode: true, isSystem: true, isActive: true, sortOrder: true },
    });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, r]));
    expect(rows).toHaveLength(2);
    expect(by[a]).toEqual({ orgId: a, name: "Online-Zahlung", untdidCode: "68", isSystem: true, isActive: true, sortOrder: 10 });
    expect(by[b]).toMatchObject({ name: "Eigene Online-Art", untdidCode: "ZZZ", isSystem: false });
  });

  it("ergaenzt ONLINE_OVERPAYMENT und ONLINE_PAYMENT_ISSUE (auch bei []), idempotent", async () => {
    expect(updates).toHaveLength(2);
    const [a, b, c] = [await mkOrg("n1"), await mkOrg("n2"), await mkOrg("n3")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: a, enabledTypesJson: '["INVOICE_OVERDUE"]' },
        { orgId: b, enabledTypesJson: "[]" },
        { orgId: c, enabledTypesJson: '["ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE"]' },
      ],
    });
    for (let i = 0; i < 2; i++) for (const u of updates) await dbInternal.$executeRawUnsafe(u);
    const rows = await dbInternal.notificationSettings.findMany({ where: { orgId: { in: [a, b, c] } }, select: { orgId: true, enabledTypesJson: true } });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, r.enabledTypesJson]));
    expect(by[a]).toBe('["INVOICE_OVERDUE","ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE"]');
    expect(by[b]).toBe('["ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE"]');
    expect(by[c]).toBe('["ONLINE_OVERPAYMENT","ONLINE_PAYMENT_ISSUE"]');
  });
});
