/**
 * Guard Bankabgleich: Importe und Zuordnungen append-only, Umsaetze nur Statusfelder aenderbar.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  dbInternal,
  prisma,
  BankMatchImmutableError,
  BankStatementImportImmutableError,
  BankTransactionImmutableError,
} from "@/lib/db";

let orgId = "";
let importId = "";
let txId = "";
let matchId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Bank-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Bank-Guard-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const invoice = await dbInternal.invoice.create({ data: { orgId, customerId: customer.id }, select: { id: true } });
  const imp = await dbInternal.bankStatementImport.create({
    data: {
      orgId,
      fileSha256: "guard-sha",
      format: "CAMT053",
      schemaVersion: "camt.053.001.08",
      entryCount: 1,
      importedCount: 1,
      duplicateCount: 0,
      skippedCount: 0,
      createdBy: "test",
    },
    select: { id: true },
  });
  importId = imp.id;
  const tx = await dbInternal.bankTransaction.create({
    data: {
      orgId,
      importId,
      accountIban: "DE02120300000000202051",
      fingerprint: "guard-fp",
      bookingDate: new Date("2200-02-01T00:00:00Z"),
      amountCents: 5000,
      currency: "EUR",
      direction: "CRDT",
    },
    select: { id: true },
  });
  txId = tx.id;
  const match = await dbInternal.bankMatch.create({
    data: { orgId, transactionId: txId, invoiceId: invoice.id, amountCents: 100, kind: "PAYMENT", confirmedBy: "test" },
    select: { id: true },
  });
  matchId = match.id;
});

describe("BankStatementImport-Guard", () => {
  it("verweigert jede Aenderung", async () => {
    const where = { id: importId };
    await expect(prisma.bankStatementImport.update({ where, data: { fileName: "x" } })).rejects.toThrow(BankStatementImportImmutableError);
    await expect(prisma.bankStatementImport.updateMany({ where, data: { fileName: "x" } })).rejects.toThrow(BankStatementImportImmutableError);
    await expect(prisma.bankStatementImport.upsert({ where, update: {}, create: {} as never })).rejects.toThrow(BankStatementImportImmutableError);
    await expect(prisma.bankStatementImport.delete({ where })).rejects.toThrow(BankStatementImportImmutableError);
    await expect(prisma.bankStatementImport.deleteMany({ where })).rejects.toThrow(BankStatementImportImmutableError);
  });
});

describe("BankMatch-Guard", () => {
  it("verweigert jede Aenderung", async () => {
    const where = { id: matchId };
    await expect(prisma.bankMatch.update({ where, data: { reason: "x" } })).rejects.toThrow(BankMatchImmutableError);
    await expect(prisma.bankMatch.updateMany({ where, data: { reason: "x" } })).rejects.toThrow(BankMatchImmutableError);
    await expect(prisma.bankMatch.updateManyAndReturn({ where, data: { reason: "x" } })).rejects.toThrow(BankMatchImmutableError);
    await expect(prisma.bankMatch.upsert({ where, update: {}, create: {} as never })).rejects.toThrow(BankMatchImmutableError);
    await expect(prisma.bankMatch.delete({ where })).rejects.toThrow(BankMatchImmutableError);
    await expect(prisma.bankMatch.deleteMany({ where })).rejects.toThrow(BankMatchImmutableError);
  });
});

describe("BankTransaction-Guard", () => {
  it("verweigert Loeschen und upsert", async () => {
    const where = { id: txId };
    await expect(prisma.bankTransaction.delete({ where })).rejects.toThrow(BankTransactionImmutableError);
    await expect(prisma.bankTransaction.deleteMany({ where })).rejects.toThrow(BankTransactionImmutableError);
    await expect(prisma.bankTransaction.upsert({ where, update: {}, create: {} as never })).rejects.toThrow(BankTransactionImmutableError);
  });

  it("verweigert Aenderung von Betrag, Fingerabdruck und Gegenkonto mit Feldnamen", async () => {
    const where = { id: txId };
    await expect(prisma.bankTransaction.update({ where, data: { amountCents: 1 } })).rejects.toThrow(/amountCents/);
    await expect(prisma.bankTransaction.update({ where, data: { fingerprint: "x" } })).rejects.toThrow(/fingerprint/);
    await expect(prisma.bankTransaction.updateMany({ where, data: { counterpartyIban: "x" } })).rejects.toThrow(/counterpartyIban/);
    await expect(prisma.bankTransaction.updateManyAndReturn({ where, data: { amountCents: 1 } })).rejects.toThrow(BankTransactionImmutableError);
  });

  it("erlaubt Status-, Zuordnungs- und Ignorierfelder", async () => {
    const where = { id: txId };
    await prisma.bankTransaction.update({ where, data: { status: "PARTIAL", allocatedCents: 100 } });
    const res = await prisma.bankTransaction.updateMany({
      where,
      data: { status: "IGNORED", ignoredReason: "privat", ignoredBy: "test", ignoredAt: new Date("2200-02-02T00:00:00Z") },
    });
    expect(res.count).toBe(1);
    const rows = await prisma.bankTransaction.updateManyAndReturn({ where, data: { status: "OPEN", allocatedCents: 0 }, select: { status: true } });
    expect(rows).toEqual([{ status: "OPEN" }]);
  });
});
