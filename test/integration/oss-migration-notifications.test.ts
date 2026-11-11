/** Phase 16e — Bestandsdaten-Migration: OSS_THRESHOLD wird in NotificationSettings.enabledTypesJson ergaenzt (SQLite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261113090000_phase16e_oss/migration.sql", "utf8");
const update = sql.slice(sql.indexOf('UPDATE "NotificationSettings"')).trim().replace(/;$/, "");

describe("16e-Migration NotificationSettings", () => {
  it("haengt OSS_THRESHOLD an (auch bei []), laesst vorhandene unveraendert, ist idempotent", async () => {
    const mkOrg = async (n: string) => (await dbInternal.organization.create({ data: { legalName: `Mig ${n}`, addressLine1: "x", postalCode: "1", city: "y" } })).id;
    const [a, b, c] = [await mkOrg("a"), await mkOrg("b"), await mkOrg("c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: a, enabledTypesJson: '["INVOICE_OVERDUE","QUOTE_EXPIRING"]' },
        { orgId: b, enabledTypesJson: "[]" },
        { orgId: c, enabledTypesJson: '["OSS_THRESHOLD"]' },
      ],
    });
    await dbInternal.$executeRawUnsafe(update);
    await dbInternal.$executeRawUnsafe(update);
    const rows = await dbInternal.notificationSettings.findMany({ where: { orgId: { in: [a, b, c] } }, select: { orgId: true, enabledTypesJson: true } });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, r.enabledTypesJson]));
    expect(by[a]).toBe('["INVOICE_OVERDUE","QUOTE_EXPIRING","OSS_THRESHOLD"]');
    expect(by[b]).toBe('["OSS_THRESHOLD"]');
    expect(by[c]).toBe('["OSS_THRESHOLD"]');
  });
});
