/**
 * Phase 17a — VIES-Pruefprotokoll (`VatIdCheck`) ist append-only: create erlaubt,
 * update/delete ueber den geschuetzten Client verboten (Guard in src/lib/db.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma } from "@/lib/db";

let orgId = "";
let customerId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "VIES-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "VIES-Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  customerId = customer.id;
});

describe("VatIdCheck-Guard (Phase 17a)", () => {
  it("VatIdCheck: create erlaubt, update/delete ueber prisma verboten", async () => {
    const row = await prisma.vatIdCheck.create({
      data: { orgId, customerId, vatId: "ATU12345678", status: "VALID", trigger: "MANUAL" },
      select: { id: true },
    });
    await expect(prisma.vatIdCheck.update({ where: { id: row.id }, data: { status: "INVALID" } })).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.vatIdCheck.updateMany({ where: { id: row.id }, data: { status: "INVALID" } })).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.vatIdCheck.delete({ where: { id: row.id } })).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.vatIdCheck.deleteMany({ where: { orgId } })).rejects.toThrow(/unveraenderlich/);
    const still = await dbInternal.vatIdCheck.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } });
    expect(still.status).toBe("VALID");
  });
});
