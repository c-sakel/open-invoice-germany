/** Bestandsdaten-Migration: KU_THRESHOLD wird in NotificationSettings.enabledTypesJson ergaenzt (SQLite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261128090000_pflichtpruefungen/migration.sql", "utf8");
const update = sql.slice(sql.indexOf('UPDATE "NotificationSettings"')).trim().replace(/;$/, "");

describe("Migration NotificationSettings (KU_THRESHOLD)", () => {
  it("haengt KU_THRESHOLD an (auch bei []), laesst vorhandene unveraendert, ist idempotent", async () => {
    const mkOrg = async (n: string) => (await dbInternal.organization.create({ data: { legalName: `Mig KU ${n}`, addressLine1: "x", postalCode: "1", city: "y" } })).id;
    const [a, b, c] = [await mkOrg("a"), await mkOrg("b"), await mkOrg("c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: a, enabledTypesJson: '["INVOICE_OVERDUE","QUOTE_EXPIRING"]' },
        { orgId: b, enabledTypesJson: "[]" },
        { orgId: c, enabledTypesJson: '["KU_THRESHOLD"]' },
      ],
    });
    await dbInternal.$executeRawUnsafe(update);
    await dbInternal.$executeRawUnsafe(update);
    const rows = await dbInternal.notificationSettings.findMany({ where: { orgId: { in: [a, b, c] } }, select: { orgId: true, enabledTypesJson: true } });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, r.enabledTypesJson]));
    expect(by[a]).toBe('["INVOICE_OVERDUE","QUOTE_EXPIRING","KU_THRESHOLD"]');
    expect(by[b]).toBe('["KU_THRESHOLD"]');
    expect(by[c]).toBe('["KU_THRESHOLD"]');
  });
});
