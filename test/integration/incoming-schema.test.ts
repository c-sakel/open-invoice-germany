/**
 * Eingangsrechnungen: Standardwerte, Eindeutigkeit je Organisation, Aenderungsschutz. Testjahr 2238.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma, IncomingInvoiceImmutableError, IncomingInvoiceValidationImmutableError } from "@/lib/db";

let orgA = "";
let orgB = "";
let invId = "";

const base = (orgId: string, sha: string) => ({
  orgId,
  receivedAt: new Date("2238-03-01T10:00:00.000Z"),
  channel: "UPLOAD",
  originalFileName: "rechnung.xml",
  originalMime: "application/xml",
  originalSize: 100,
  originalSha256: sha,
  originalPath: `incoming/${sha}`,
  kind: "EINVOICE",
  createdBy: "test",
});

async function mkOrg(name: string): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  return org.id;
}

beforeAll(async () => {
  orgA = await mkOrg("Eingang Schema A GmbH");
  orgB = await mkOrg("Eingang Schema B GmbH");
  const inv = await dbInternal.incomingInvoice.create({ data: base(orgA, "a".repeat(64)), select: { id: true } });
  invId = inv.id;
});

describe("IncomingInvoice Schema", () => {
  it("setzt Standardwerte", async () => {
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({
      where: { id: invId },
      select: { validationStatus: true, status: true, hintsJson: true, isEInvoice: true },
    });
    expect(row).toEqual({ validationStatus: "PENDING", status: "NEW", hintsJson: "[]", isEInvoice: false });
  });

  it("gleicher Hash: je Organisation einmal", async () => {
    await expect(dbInternal.incomingInvoice.create({ data: base(orgA, "a".repeat(64)) })).rejects.toMatchObject({ code: "P2002" });
    await expect(dbInternal.incomingInvoice.create({ data: base(orgB, "a".repeat(64)), select: { id: true } })).resolves.toBeTruthy();
  });
});

describe("IncomingInvoice Aenderungsschutz", () => {
  const where = () => ({ id: invId });

  it("Status und Pruefstatus sind aenderbar", async () => {
    await prisma.incomingInvoice.update({ where: where(), data: { status: "REVIEWED" } });
    await prisma.incomingInvoice.update({ where: where(), data: { validationStatus: "VALID" } });
    await prisma.incomingInvoice.updateMany({ where: where(), data: { status: "NEW" } });
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: where(), select: { status: true, validationStatus: true } });
    expect(row).toEqual({ status: "NEW", validationStatus: "VALID" });
  });

  for (const key of ["number", "originalSha256", "originalPath", "xmlPath", "receivedAt", "duplicateOfId", "orgId"] as const) {
    it(`${key} ist gesperrt`, async () => {
      const data = { [key]: key === "receivedAt" ? new Date() : "x" } as never;
      await expect(prisma.incomingInvoice.update({ where: where(), data })).rejects.toThrow(IncomingInvoiceImmutableError);
      await expect(prisma.incomingInvoice.updateMany({ where: where(), data })).rejects.toThrow(IncomingInvoiceImmutableError);
      await expect(prisma.incomingInvoice.updateManyAndReturn({ where: where(), data })).rejects.toThrow(IncomingInvoiceImmutableError);
    });
  }

  it("upsert und Loeschen sind gesperrt", async () => {
    await expect(
      prisma.incomingInvoice.upsert({ where: where(), create: base(orgA, "b".repeat(64)), update: { status: "NEW" } }),
    ).rejects.toThrow(IncomingInvoiceImmutableError);
    await expect(prisma.incomingInvoice.delete({ where: where() })).rejects.toThrow(IncomingInvoiceImmutableError);
    await expect(prisma.incomingInvoice.deleteMany({ where: where() })).rejects.toThrow(IncomingInvoiceImmutableError);
  });
});

describe("IncomingInvoiceValidation append-only", () => {
  it("create ok, Aenderung und Loeschen gesperrt", async () => {
    const v = await prisma.incomingInvoiceValidation.create({
      data: { incomingInvoiceId: invId, engine: "test", artefactVersion: "1", result: "VALID" },
      select: { id: true, findingsJson: true },
    });
    expect(v.findingsJson).toBe("[]");
    const w = { id: v.id };
    await expect(prisma.incomingInvoiceValidation.update({ where: w, data: { result: "INVALID" } })).rejects.toThrow(
      IncomingInvoiceValidationImmutableError,
    );
    await expect(prisma.incomingInvoiceValidation.updateMany({ where: w, data: { result: "INVALID" } })).rejects.toThrow(
      IncomingInvoiceValidationImmutableError,
    );
    await expect(prisma.incomingInvoiceValidation.delete({ where: w })).rejects.toThrow(IncomingInvoiceValidationImmutableError);
    await expect(prisma.incomingInvoiceValidation.deleteMany({ where: w })).rejects.toThrow(IncomingInvoiceValidationImmutableError);
  });
});
