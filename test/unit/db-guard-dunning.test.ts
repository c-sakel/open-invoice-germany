/**
 * Phase 16a — Mahnungs-Guard in src/lib/db.ts: `pdfPath`/`pdfSha256` (Mahnungsarchiv) sind
 * ueber den geschuetzten Client verboten (write-once nur in src/domain/dunning/archive.ts
 * per dbInternal), nur `sentAt` bleibt erlaubt; jede inhaltliche Aenderung bleibt verboten.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma } from "@/lib/db";

let dunningId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Guard-Test GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const invoice = await dbInternal.invoice.create({
    data: { orgId: org.id, customerId: customer.id },
    select: { id: true },
  });
  const dunning = await dbInternal.dunning.create({
    data: { invoiceId: invoice.id, level: 1 },
    select: { id: true },
  });
  dunningId = dunning.id;
});

describe("Dunning-Guard (Phase 16a)", () => {
  it("verweigert pdfPath/pdfSha256 ueber den geschuetzten Client (write-once nur ueber das Archiv)", async () => {
    await expect(prisma.dunning.update({ where: { id: dunningId }, data: { pdfSha256: "x" } })).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.dunning.updateMany({ where: { id: dunningId }, data: { pdfPath: "x" } })).rejects.toThrow(/unveraenderlich/);
    const row = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunningId }, select: { pdfSha256: true, pdfPath: true } });
    expect(row).toEqual({ pdfSha256: null, pdfPath: null });
  });

  it("erlaubt sentAt", async () => {
    await prisma.dunning.update({ where: { id: dunningId }, data: { sentAt: new Date("2045-01-01") } });
  });

  it("verweigert weiterhin inhaltliche Aenderungen (level)", async () => {
    await expect(prisma.dunning.update({ where: { id: dunningId }, data: { level: 2 } })).rejects.toThrow(/unveraenderlich/);
  });
});
