/** Phase 16d — Bestandsdaten-Migration: Postversand-Meldungstypen werden in NotificationSettings.enabledTypesJson ergaenzt (SQLite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261117090000_phase16d_postal/migration.sql", "utf8");
const updates = sql
  .slice(sql.indexOf('UPDATE "NotificationSettings"'))
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.startsWith("UPDATE"));

describe("16d-Migration NotificationSettings", () => {
  it("ergaenzt POSTAL_FAILED, POSTAL_PENDING, DUNNING_NOT_SENT (auch bei []), idempotent", async () => {
    expect(updates).toHaveLength(3);
    const mkOrg = async (n: string) => (await dbInternal.organization.create({ data: { legalName: `MigP ${n}`, addressLine1: "x", postalCode: "1", city: "y" } })).id;
    const [a, b, c] = [await mkOrg("a"), await mkOrg("b"), await mkOrg("c")];
    await dbInternal.notificationSettings.createMany({
      data: [
        { orgId: a, enabledTypesJson: '["INVOICE_OVERDUE"]' },
        { orgId: b, enabledTypesJson: "[]" },
        { orgId: c, enabledTypesJson: '["POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT"]' },
      ],
    });
    for (let i = 0; i < 2; i++) for (const u of updates) await dbInternal.$executeRawUnsafe(u);
    const rows = await dbInternal.notificationSettings.findMany({ where: { orgId: { in: [a, b, c] } }, select: { orgId: true, enabledTypesJson: true } });
    const by = Object.fromEntries(rows.map((r) => [r.orgId, r.enabledTypesJson]));
    expect(by[a]).toBe('["INVOICE_OVERDUE","POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT"]');
    expect(by[b]).toBe('["POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT"]');
    expect(by[c]).toBe('["POSTAL_FAILED","POSTAL_PENDING","DUNNING_NOT_SENT"]');
  });
});
