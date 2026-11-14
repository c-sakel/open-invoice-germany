/**
 * Guard fuer das Kundenportal-Abrufprotokoll: append-only, Loeschung nur ueber dbInternal.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma, CustomerPortalEventImmutableError } from "@/lib/db";

let orgId = "";
let linkId = "";
let eventId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Portal-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Portal-Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const link = await dbInternal.customerPortalLink.create({
    data: {
      orgId,
      customerId: customer.id,
      tokenHash: "guard-hash-" + "a".repeat(32),
      tokenEnc: "enc",
      expiresAt: new Date("2195-01-01T00:00:00Z"),
      createdBy: "test",
    },
    select: { id: true },
  });
  linkId = link.id;
  const ev = await dbInternal.customerPortalEvent.create({
    data: { orgId, linkId, kind: "VIEW" },
    select: { id: true },
  });
  eventId = ev.id;
});

describe("CustomerPortalEvent-Guard", () => {
  it("verweigert update/updateMany/upsert/delete/deleteMany", async () => {
    await expect(prisma.customerPortalEvent.update({ where: { id: eventId }, data: { kind: "X" } })).rejects.toThrow(
      CustomerPortalEventImmutableError,
    );
    await expect(prisma.customerPortalEvent.updateMany({ where: { id: eventId }, data: { kind: "X" } })).rejects.toThrow(
      CustomerPortalEventImmutableError,
    );
    await expect(prisma.customerPortalEvent.updateManyAndReturn({ where: { id: eventId }, data: { kind: "X" } })).rejects.toThrow(
      CustomerPortalEventImmutableError,
    );
    await expect(
      prisma.customerPortalEvent.upsert({
        where: { id: eventId },
        update: { kind: "X" },
        create: { orgId, linkId, kind: "VIEW" },
      }),
    ).rejects.toThrow(CustomerPortalEventImmutableError);
    await expect(prisma.customerPortalEvent.delete({ where: { id: eventId } })).rejects.toThrow(CustomerPortalEventImmutableError);
    await expect(prisma.customerPortalEvent.deleteMany({ where: { id: eventId } })).rejects.toThrow(
      CustomerPortalEventImmutableError,
    );
  });

  it("erlaubt create ueber den geschuetzten Client", async () => {
    const ev = await prisma.customerPortalEvent.create({
      data: { orgId, linkId, kind: "DOWNLOAD", docType: "INVOICE", docId: "d1", fileKind: "PDF" },
      select: { id: true },
    });
    expect(ev.id).toBeTruthy();
  });

  it("erlaubt deleteMany ueber dbInternal (Aufbewahrungs-Cleanup)", async () => {
    const res = await dbInternal.customerPortalEvent.deleteMany({ where: { linkId, kind: "DOWNLOAD" } });
    expect(res.count).toBe(1);
  });
});
