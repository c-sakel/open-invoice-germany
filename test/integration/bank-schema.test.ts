/**
 * Schema Bankabgleich: Defaults, Unique-Regeln, Restrict-Fremdschluessel.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";

let orgId = "";
let otherOrgId = "";
let importId = "";
let otherImportId = "";
let invoiceId = "";
let txId = "";

function txData(fingerprint: string, org = orgId, imp = importId) {
  return {
    orgId: org,
    importId: imp,
    accountIban: "DE02120300000000202051",
    fingerprint,
    bookingDate: new Date("2200-02-01T00:00:00Z"),
    amountCents: 11900,
    currency: "EUR",
    direction: "CRDT",
  };
}

function importData(org: string, sha: string) {
  return {
    orgId: org,
    fileSha256: sha,
    format: "CAMT053",
    schemaVersion: "camt.053.001.08",
    entryCount: 1,
    importedCount: 1,
    duplicateCount: 0,
    skippedCount: 0,
    createdBy: "test",
  };
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Bank-Schema GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const other = await dbInternal.organization.create({
    data: { legalName: "Bank-Schema Zwei GmbH", addressLine1: "Weg 3", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  otherOrgId = other.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Bank-Schema-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const invoice = await dbInternal.invoice.create({
    data: { orgId, customerId: customer.id },
    select: { id: true },
  });
  invoiceId = invoice.id;
  const imp = await dbInternal.bankStatementImport.create({ data: importData(orgId, "schema-sha-a"), select: { id: true } });
  importId = imp.id;
  const imp2 = await dbInternal.bankStatementImport.create({ data: importData(otherOrgId, "schema-sha-b"), select: { id: true } });
  otherImportId = imp2.id;
});

describe("Schema Bankabgleich", () => {
  it("Umsatz startet mit den Standardwerten", async () => {
    const t = await dbInternal.bankTransaction.create({
      data: txData("fp-1"),
      select: { id: true, status: true, allocatedCents: true, remittance: true },
    });
    txId = t.id;
    expect(t).toMatchObject({ status: "OPEN", allocatedCents: 0, remittance: "" });
  });

  it("(orgId, fileSha256) ist eindeutig", async () => {
    await expect(dbInternal.bankStatementImport.create({ data: importData(orgId, "schema-sha-a") })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("(orgId, fingerprint) ist je Organisation eindeutig, in einer zweiten Organisation erlaubt", async () => {
    await expect(dbInternal.bankTransaction.create({ data: txData("fp-1") })).rejects.toMatchObject({ code: "P2002" });
    const t = await dbInternal.bankTransaction.create({ data: txData("fp-1", otherOrgId, otherImportId), select: { id: true } });
    expect(t.id).toBeTruthy();
  });

  it("BankMatch.paymentId ist eindeutig", async () => {
    const pay = await dbInternal.payment.create({ data: { invoiceId, amountCents: 100 }, select: { id: true } });
    const matchData = {
      orgId,
      transactionId: txId,
      invoiceId,
      paymentId: pay.id,
      amountCents: 100,
      kind: "PAYMENT",
      confirmedBy: "test",
    };
    const m = await dbInternal.bankMatch.create({ data: matchData, select: { id: true } });
    expect(m.id).toBeTruthy();
    await expect(dbInternal.bankMatch.create({ data: matchData })).rejects.toMatchObject({ code: "P2002" });
  });

  it("Umsatz mit Zuordnung ist nicht loeschbar (Restrict)", async () => {
    await expect(dbInternal.bankTransaction.delete({ where: { id: txId } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("Zuordnung ohne Umsatz scheitert (Fremdschluessel)", async () => {
    await expect(
      dbInternal.bankMatch.create({
        data: { orgId, transactionId: "gibt-es-nicht", invoiceId, amountCents: 1, kind: "PAYMENT", confirmedBy: "test" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
