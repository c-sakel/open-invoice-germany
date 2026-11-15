/** Bestandsdaten-Migration: Zahlungsregel-Meldungstypen werden in NotificationSettings.enabledTypesJson ergaenzt (SQLite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261124090000_zahlungsaktionen/migration.sql", "utf8");
const updates = sql
  .slice(sql.indexOf('UPDATE "NotificationSettings"'))
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.startsWith("UPDATE"));

describe("Migration Zahlungsaktionen: NotificationSettings", () => {
  it("ergaenzt PAYMENT_RULE und PAYMENT_RULE_FAILED (auch bei []), idempotent", async () => {
    expect(updates).toHaveLength(2);
    const mkOrg = async (n: string) =>
      (await dbInternal.organization.create({ data: { legalName: `MigZ ${n}`, addressLine1: "x", postalCode: "1", city: "y" }, select: { id: true } })).id;
    const [a, b, c] = [await mkOrg("a"), await mkOrg("b"), await mkOrg("c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: a, enabledTypesJson: '["INVOICE_OVERDUE"]' },
        { orgId: b, enabledTypesJson: "[]" },
        { orgId: c, enabledTypesJson: '["PAYMENT_RULE","PAYMENT_RULE_FAILED"]' },
      ],
    });
    for (let i = 0; i < 2; i++) for (const u of updates) await dbInternal.$executeRawUnsafe(u);
    const rows = await dbInternal.notificationSettings.findMany({
      where: { orgId: { in: [a, b, c] } },
      select: { orgId: true, enabledTypesJson: true },
    });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, r.enabledTypesJson]));
    expect(by[a]).toBe('["INVOICE_OVERDUE","PAYMENT_RULE","PAYMENT_RULE_FAILED"]');
    expect(by[b]).toBe('["PAYMENT_RULE","PAYMENT_RULE_FAILED"]');
    expect(by[c]).toBe('["PAYMENT_RULE","PAYMENT_RULE_FAILED"]');
  });
});
