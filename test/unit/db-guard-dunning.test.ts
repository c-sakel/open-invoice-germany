/**
 * Phase 16a, Task 1 — Mahnungs-Guard in src/lib/db.ts: `pdfSha256` (Pruefsumme des
 * archivierten Mahn-PDFs) darf wie `sentAt`/`pdfPath` nachtraeglich gesetzt werden, jede
 * inhaltliche Aenderung bleibt verboten. Rohdaten ueber dbInternal, Update ueber den
 * geschuetzten Client.
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
  it("erlaubt das nachtraegliche Setzen von pdfSha256", async () => {
    await prisma.dunning.update({ where: { id: dunningId }, data: { pdfSha256: "x" } });
    const row = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunningId }, select: { pdfSha256: true } });
    expect(row.pdfSha256).toBe("x");
  });

  it("verweigert weiterhin inhaltliche Aenderungen (level)", async () => {
    await expect(prisma.dunning.update({ where: { id: dunningId }, data: { level: 2 } })).rejects.toThrow(/unveraenderlich/);
  });
});
