/**
 * Schema Kundenportal: Defaults, Unique-Regeln, Restrict-Fremdschluessel.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";

let orgId = "";
let customerId = "";

function linkData(tokenHash: string) {
  return {
    orgId,
    customerId,
    tokenHash,
    tokenEnc: "enc",
    expiresAt: new Date("2195-01-01T00:00:00Z"),
    createdBy: "test",
  };
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Portal-Schema GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Portal-Schema-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  customerId = customer.id;
});

describe("Schema Kundenportal", () => {
  it("Einstellungen starten mit den Standardwerten", async () => {
    const s = await dbInternal.customerPortalSettings.create({
      data: { orgId },
      select: { enabled: true, linkDays: true, showDunnings: true, showEInvoice: true, mailSubject: true, mailBody: true },
    });
    expect(s).toEqual({
      enabled: false,
      linkDays: 365,
      showDunnings: true,
      showEInvoice: true,
      mailSubject: null,
      mailBody: null,
    });
  });

  it("zweite Einstellungszeile je Organisation scheitert", async () => {
    await expect(dbInternal.customerPortalSettings.create({ data: { orgId } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("tokenHash ist eindeutig", async () => {
    const link = await dbInternal.customerPortalLink.create({
      data: linkData("schema-hash-unique"),
      select: { viewCount: true, revokedAt: true },
    });
    expect(link).toEqual({ viewCount: 0, revokedAt: null });
    await expect(dbInternal.customerPortalLink.create({ data: linkData("schema-hash-unique") })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("Kunde mit Link ist nicht loeschbar (Restrict)", async () => {
    await expect(dbInternal.customer.delete({ where: { id: customerId } })).rejects.toThrow();
    const still = await dbInternal.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    expect(still).not.toBeNull();
  });

  it("Ereignis ohne Link wird abgewiesen (Fremdschluessel)", async () => {
    await expect(
      dbInternal.customerPortalEvent.create({ data: { orgId, linkId: "gibt-es-nicht", kind: "VIEW" } }),
    ).rejects.toThrow();
  });

  it("Link mit Ereignis ist nicht loeschbar (Restrict)", async () => {
    const link = await dbInternal.customerPortalLink.create({
      data: linkData("schema-hash-event"),
      select: { id: true },
    });
    await dbInternal.customerPortalEvent.create({ data: { orgId, linkId: link.id, kind: "VIEW" } });
    await expect(dbInternal.customerPortalLink.delete({ where: { id: link.id } })).rejects.toThrow();
  });
});
