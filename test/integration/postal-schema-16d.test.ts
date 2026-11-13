/**
 * Phase 16d — Schema Postversand: Defaults auf Bestandszeilen, Unique-Regeln, Restrict-FK.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";

let orgId = "";

function jobData(over: { providerJobId?: number | null } = {}) {
  return {
    orgId,
    docType: "INVOICE",
    docId: "doc-schema-16d",
    invoiceId: "inv-schema-16d",
    docNumber: "RE-SCHEMA-16D",
    mode: "DRY_RUN",
    trigger: "USER",
    status: "PENDING",
    filename: `RE-SCHEMA-16D-${Math.random().toString(36).slice(2)}.pdf`,
    pages: 1,
    color: "1",
    duplex: false,
    shipping: "auto",
    pdfSha256: "a".repeat(64),
    base64Md5: "b".repeat(32),
    createdBy: "test",
    ...over,
  };
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Postal-Schema GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
});

describe("Schema Phase 16d", () => {
  it("Kunde und Mahnstufe ohne neue Felder erhalten die Defaults", async () => {
    const c = await dbInternal.customer.create({
      data: { orgId, name: "Kanal-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
      select: { deliveryChannel: true },
    });
    expect(c.deliveryChannel).toBe("EMAIL");
    const s = await dbInternal.dunningStage.create({
      data: { orgId, order: 1, name: "Stufe", daysAfterDue: 7, calculateInterest: false, includeB2BFlatFee: false },
      select: { channel: true, postFallback: true },
    });
    expect(s).toEqual({ channel: "CUSTOMER", postFallback: true });
  });

  it("PostalSettings: Defaults und Unique je Organisation", async () => {
    const ps = await dbInternal.postalSettings.create({
      data: { orgId },
      select: { enabled: true, mode: true, autoDunningPost: true, color: true, shipping: true, duplex: true },
    });
    expect(ps).toEqual({ enabled: false, mode: "DRY_RUN", autoDunningPost: false, color: "1", shipping: "auto", duplex: false });
    await expect(dbInternal.postalSettings.create({ data: { orgId } })).rejects.toThrow();
  });

  it("PostalJob: mehrere NULL-providerJobId erlaubt, Duplikat scheitert", async () => {
    await dbInternal.postalJob.create({ data: jobData({ providerJobId: null }) });
    await dbInternal.postalJob.create({ data: jobData({ providerJobId: null }) });
    await dbInternal.postalJob.create({ data: jobData({ providerJobId: 4711 }) });
    await expect(dbInternal.postalJob.create({ data: jobData({ providerJobId: 4711 }) })).rejects.toThrow();
  });

  it("PostalJob: filename je Organisation eindeutig", async () => {
    const data = jobData();
    await dbInternal.postalJob.create({ data });
    await expect(dbInternal.postalJob.create({ data })).rejects.toThrow();
  });

  it("PostalJob mit Ereignis ist nicht loeschbar (Restrict)", async () => {
    const job = await dbInternal.postalJob.create({ data: jobData(), select: { id: true } });
    await dbInternal.postalJobEvent.create({ data: { jobId: job.id, orgId, kind: "CREATED", status: "PENDING" } });
    await expect(dbInternal.postalJob.delete({ where: { id: job.id } })).rejects.toThrow();
  });
});
