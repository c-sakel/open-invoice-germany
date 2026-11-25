/** Geldlogik-Migration — Bestandsdaten: Skonto-Basis festgeschriebener Schlussrechnungen wird eingefroren (SQLite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";

const sql = readFileSync("prisma/migrations/20261208090000_geldlogik/migration.sql", "utf8");
const update = sql
  .slice(sql.indexOf('UPDATE "Invoice"'))
  .split(";")
  .map((s) => s.trim())
  .find((s) => s.startsWith("UPDATE"));

describe("Geldlogik-Migration Bestand", () => {
  it("setzt skontoBaseCents nur bei festgeschriebenen Schlussrechnungen mit Skonto, idempotent", async () => {
    expect(update).toBeDefined();
    const org = await dbInternal.organization.create({ data: { legalName: "MigG Org", addressLine1: "x", postalCode: "1", city: "y" } });
    const customer = await dbInternal.customer.create({
      data: { orgId: org.id, name: "MigG Kunde", addressLine1: "x", postalCode: "1", city: "y" },
    });
    const skonto = { skonto1Permille: 20, skonto1Days: 7 };
    const mk = (number: string, type: string, status: string, withSkonto: boolean) =>
      dbInternal.invoice.create({
        data: { orgId: org.id, customerId: customer.id, number, type, status, grossTotalCents: 1190000, ...(withSkonto ? skonto : {}) },
        select: { id: true },
      });
    const finalFin = await mk("MIGG-2290-1", "FINAL", "FINALIZED", true);
    const finalDraft = await mk("MIGG-2290-2", "FINAL", "DRAFT", true);
    const invFin = await mk("MIGG-2290-3", "INVOICE", "FINALIZED", true);
    const finalNoSkonto = await mk("MIGG-2290-4", "FINAL", "FINALIZED", false);

    await dbInternal.$executeRawUnsafe(update as string);
    const read = async () => {
      const rows = await dbInternal.invoice.findMany({
        where: { id: { in: [finalFin.id, finalDraft.id, invFin.id, finalNoSkonto.id] } },
        select: { id: true, skontoBaseCents: true },
      });
      return Object.fromEntries(rows.map((r) => [r.id, r.skontoBaseCents]));
    };
    const first = await read();
    expect(first[finalFin.id]).toBe(1190000);
    expect(first[finalDraft.id]).toBeNull();
    expect(first[invFin.id]).toBeNull();
    expect(first[finalNoSkonto.id]).toBeNull();

    await dbInternal.$executeRawUnsafe(update as string);
    expect(await read()).toEqual(first);
  });
});
