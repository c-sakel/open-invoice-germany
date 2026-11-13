/**
 * Phase 16d — Guard fuer das Postversand-Protokoll: Ereignisse append-only, Auftraege nie
 * loeschbar, nur Status-/Preis-/Verfolgungsfelder fortschreibbar.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma } from "@/lib/db";

let jobId = "";
let eventId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Postal-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const job = await dbInternal.postalJob.create({
    data: {
      orgId: org.id,
      docType: "INVOICE",
      docId: "doc-guard-16d",
      invoiceId: "inv-guard-16d",
      docNumber: "RE-GUARD-16D",
      mode: "DRY_RUN",
      trigger: "USER",
      status: "PENDING",
      filename: "RE-GUARD-16D-x.pdf",
      pages: 1,
      color: "1",
      duplex: false,
      shipping: "auto",
      pdfSha256: "a".repeat(64),
      base64Md5: "b".repeat(32),
      createdBy: "test",
    },
    select: { id: true },
  });
  jobId = job.id;
  const ev = await dbInternal.postalJobEvent.create({
    data: { jobId, orgId: org.id, kind: "CREATED", status: "PENDING" },
    select: { id: true },
  });
  eventId = ev.id;
});

describe("PostalJobEvent-Guard (Phase 16d)", () => {
  it("verweigert update/updateMany/upsert/delete/deleteMany", async () => {
    await expect(prisma.postalJobEvent.update({ where: { id: eventId }, data: { status: "X" } })).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.postalJobEvent.updateMany({ where: { id: eventId }, data: { status: "X" } })).rejects.toThrow(/unveraenderlich/);
    await expect(
      prisma.postalJobEvent.upsert({
        where: { id: eventId },
        update: { status: "X" },
        create: { jobId, orgId: "o", kind: "CREATED", status: "PENDING" },
      }),
    ).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.postalJobEvent.delete({ where: { id: eventId } })).rejects.toThrow(/unveraenderlich/);
    await expect(prisma.postalJobEvent.deleteMany({ where: { id: eventId } })).rejects.toThrow(/unveraenderlich/);
  });

  it("erlaubt create", async () => {
    const ev = await prisma.postalJobEvent.create({
      data: { jobId, orgId: "o", kind: "STATUS", status: "QUEUED" },
      select: { id: true },
    });
    expect(ev.id).toBeTruthy();
  });
});

describe("PostalJob-Guard (Phase 16d)", () => {
  it("verweigert delete/deleteMany/upsert", async () => {
    await expect(prisma.postalJob.delete({ where: { id: jobId } })).rejects.toThrow(/nicht aenderbar/);
    await expect(prisma.postalJob.deleteMany({ where: { id: jobId } })).rejects.toThrow(/nicht aenderbar/);
    await expect(
      prisma.postalJob.upsert({ where: { id: jobId }, update: { status: "DONE" }, create: {} as never }),
    ).rejects.toThrow(/nicht aenderbar/);
  });

  it("erlaubt Status, Preis und Verfolgung", async () => {
    await prisma.postalJob.update({
      where: { id: jobId },
      data: { status: "DONE", priceCents: 68, trackingCode: "TRK-16D" },
    });
    const row = await dbInternal.postalJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, priceCents: true, trackingCode: true },
    });
    expect(row).toEqual({ status: "DONE", priceCents: 68, trackingCode: "TRK-16D" });
  });

  it("verweigert Kernfelder mit Schluesselnamen", async () => {
    await expect(prisma.postalJob.update({ where: { id: jobId }, data: { pdfSha256: "x" } })).rejects.toThrow(/pdfSha256/);
    await expect(prisma.postalJob.update({ where: { id: jobId }, data: { docId: "x" } })).rejects.toThrow(/docId/);
    await expect(prisma.postalJob.updateMany({ where: { id: jobId }, data: { mode: "LIVE" } })).rejects.toThrow(/mode/);
    const row = await dbInternal.postalJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { pdfSha256: true, docId: true, mode: true },
    });
    expect(row).toEqual({ pdfSha256: "a".repeat(64), docId: "doc-guard-16d", mode: "DRY_RUN" });
  });
});
