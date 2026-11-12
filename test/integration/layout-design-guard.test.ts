import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dbInternal,
  prisma,
  DunningImmutabilityError,
  LayoutDesignDeleteError,
  LayoutDesignVersionImmutabilityError,
} from "@/lib/db";

let orgId: string;
let designId: string;
let versionId: string;
let dunningId: string;
let invoiceId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Guard GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lueneburg" },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Guard Kunde AG", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const invoice = await dbInternal.invoice.create({
    data: { orgId, customerId: customer.id, status: "DRAFT" },
    select: { id: true },
  });
  invoiceId = invoice.id;
  const dunning = await dbInternal.dunning.create({ data: { invoiceId, level: 1 }, select: { id: true } });
  dunningId = dunning.id;
  const design = await dbInternal.layoutDesign.create({
    data: {
      orgId,
      name: "Guard-Design",
      versions: { create: { version: 1, configJson: '{"version":1}', configHash: "h1" } },
    },
    select: { id: true, versions: { select: { id: true } } },
  });
  designId = design.id;
  versionId = design.versions[0].id;
});

afterAll(async () => {
  await dbInternal.dunning.deleteMany({ where: { invoiceId } });
  await dbInternal.invoice.deleteMany({ where: { orgId } });
  await dbInternal.layoutDesignVersion.deleteMany({ where: { designId } });
  await dbInternal.layoutDesign.deleteMany({ where: { orgId } });
  await dbInternal.customer.deleteMany({ where: { orgId } });
  await dbInternal.organization.delete({ where: { id: orgId } });
});

describe("LayoutDesignVersion ist unveraenderlich", () => {
  const E = LayoutDesignVersionImmutabilityError;
  it("update", async () => {
    await expect(prisma.layoutDesignVersion.update({ where: { id: versionId }, data: { configJson: "{}" } })).rejects.toBeInstanceOf(E);
  });
  it("updateMany", async () => {
    await expect(prisma.layoutDesignVersion.updateMany({ where: { designId }, data: { configHash: "x" } })).rejects.toBeInstanceOf(E);
  });
  it("upsert", async () => {
    await expect(
      prisma.layoutDesignVersion.upsert({
        where: { id: versionId },
        create: { designId, version: 9, configJson: "{}", configHash: "x" },
        update: { configHash: "y" },
      }),
    ).rejects.toBeInstanceOf(E);
  });
  it("delete", async () => {
    await expect(prisma.layoutDesignVersion.delete({ where: { id: versionId } })).rejects.toBeInstanceOf(E);
  });
  it("deleteMany", async () => {
    await expect(prisma.layoutDesignVersion.deleteMany({ where: { designId } })).rejects.toBeInstanceOf(E);
  });
  it("create bleibt erlaubt", async () => {
    const v = await prisma.layoutDesignVersion.create({
      data: { designId, version: 2, configJson: '{"version":1,"x":1}', configHash: "h2" },
      select: { version: true },
    });
    expect(v.version).toBe(2);
  });
});

describe("LayoutDesign wird nie geloescht", () => {
  it("delete", async () => {
    await expect(prisma.layoutDesign.delete({ where: { id: designId } })).rejects.toBeInstanceOf(LayoutDesignDeleteError);
  });
  it("deleteMany", async () => {
    await expect(prisma.layoutDesign.deleteMany({ where: { orgId } })).rejects.toBeInstanceOf(LayoutDesignDeleteError);
  });
  it("archivieren (update) ist erlaubt", async () => {
    const d = await prisma.layoutDesign.update({ where: { id: designId }, data: { archived: true }, select: { archived: true } });
    expect(d.archived).toBe(true);
  });
});

describe("Dunning.layoutVersionId ist ueber den geschuetzten Client nicht setzbar", () => {
  it("update mit layoutVersionId", async () => {
    await expect(prisma.dunning.update({ where: { id: dunningId }, data: { layoutVersionId: versionId } })).rejects.toBeInstanceOf(
      DunningImmutabilityError,
    );
  });
  it("updateManyAndReturn mit layoutVersionId", async () => {
    await expect(
      prisma.dunning.updateManyAndReturn({ where: { id: dunningId }, data: { layoutVersionId: versionId } }),
    ).rejects.toBeInstanceOf(DunningImmutabilityError);
  });
  it("upsert mit layoutVersionId im Update-Zweig", async () => {
    const existing = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunningId } });
    const { id: _id, ...create } = existing;
    void _id;
    await expect(
      prisma.dunning.upsert({ where: { id: dunningId }, create, update: { layoutVersionId: versionId } }),
    ).rejects.toBeInstanceOf(DunningImmutabilityError);
  });
});
