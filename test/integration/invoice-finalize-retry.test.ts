/**
 * Festschreiben und Stornieren wiederholen bei einem ChangeLog-Kettenkonflikt (23c T9): der erste Versuch
 * laeuft real durch und scheitert erst beim Commit-Punkt (P2002 orgId+prevHash) -> vollstaendiger Rollback,
 * zweiter Versuch gelingt, genau eine Nummer, Kette gueltig. Testjahr 2324.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { createInvoiceSchema } from "@/schemas";

const NOW = new Date("2324-05-01T10:00:00.000Z");
let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Kettenretry GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE555666780", taxNumber: "55/666/77779" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  orgId = org.id;
  customerId = (await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  })).id;
});

afterEach(() => vi.restoreAllMocks());

const draft = async () =>
  (await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", deliveryDate: NOW,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  )).id;

type TxFn = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TxHost = { $transaction: (fn: TxFn) => Promise<unknown> };

/** Der naechste Transaktionsaufruf laeuft vollstaendig und scheitert erst am Ende mit einem Kettenkonflikt (Rollback). */
function conflictOnce(times = 1): { calls: () => number } {
  const host = dbInternal as unknown as TxHost;
  const original = host.$transaction.bind(host);
  let left = times;
  const spy = vi.spyOn(host, "$transaction").mockImplementation((fn: TxFn) => {
    if (left <= 0) return original(fn);
    left--;
    return original(async (tx) => {
      await fn(tx);
      throw new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x", meta: { target: ["orgId", "prevHash"] } });
    });
  });
  return { calls: () => spy.mock.calls.length };
}

describe("Kettenkonflikt beim Festschreiben und Stornieren", () => {
  it("Festschreiben: ein Konflikt wird wiederholt, genau eine Nummer, Kette gueltig", async () => {
    const id = await draft();
    const before = await dbInternal.invoice.count({ where: { orgId, number: { not: null } } });
    const c = conflictOnce();
    const inv = await finalizeInvoice(id, { now: NOW });
    expect(c.calls()).toBe(2);
    expect(inv.status).toBe("FINALIZED");
    expect(inv.number).toBeTruthy();
    expect(await dbInternal.invoice.count({ where: { orgId, number: { not: null } } })).toBe(before + 1);
    expect(await dbInternal.changeLog.count({ where: { orgId, entityId: id, action: "FINALIZE" } })).toBe(1);
    expect((await verifyOrgChain(orgId, "API")).valid).toBe(true);
  });

  it("Storno: ein Konflikt wird wiederholt, genau eine Gutschrift, Kette gueltig", async () => {
    const id = await draft();
    await finalizeInvoice(id, { now: NOW });
    const c = conflictOnce();
    const res = await cancelInvoice(id, { orgId, actor: "test", now: NOW });
    expect(c.calls()).toBe(2);
    expect(res.creditNote.number).toBeTruthy();
    const orig = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, reversedByInvoiceId: true } });
    expect(orig.status).toBe("CANCELLED");
    expect(orig.reversedByInvoiceId).toBe(res.creditNote.id);
    expect(await dbInternal.invoice.count({ where: { orgId, type: "CREDIT_NOTE" } })).toBe(1);
    expect((await verifyOrgChain(orgId, "API")).valid).toBe(true);
  });

  it("sieben Konflikte nacheinander (8 Versuche): Nummer lueckenlos, genau ein Outbox-Eintrag", async () => {
    await dbInternal.webhookEndpoint.create({
      data: { orgId, url: "https://93.184.216.50/hook", secretEnc: "v1:x:x:x", eventsJson: '["invoice.finalized"]' },
    });
    const first = await finalizeInvoice(await draft(), { now: NOW });
    const id = await draft();
    const c = conflictOnce(7);
    const inv = await finalizeInvoice(id, { now: NOW });
    expect(c.calls()).toBe(8);
    const seq = (n: string | null) => Number((n ?? "").match(/(\d+)$/)?.[1]);
    expect(seq(inv.number)).toBe(seq(first.number) + 1);
    expect(await dbInternal.webhookDelivery.count({ where: { orgId, objectId: id, event: "invoice.finalized" } })).toBe(1);
    expect((await verifyOrgChain(orgId, "API")).valid).toBe(true);
  });

  it("Retry-Erschoepfung: dauerhafter Konflikt wirft nach 8 Versuchen, keine Nummer vergeben, nichts verbucht", async () => {
    const id = await draft();
    const before = await dbInternal.invoice.count({ where: { orgId, number: { not: null } } });
    const c = conflictOnce(100);
    await expect(finalizeInvoice(id, { now: NOW })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(c.calls()).toBe(8);
    vi.restoreAllMocks();
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, number: true } });
    expect(after).toEqual({ status: "DRAFT", number: null });
    expect(await dbInternal.invoice.count({ where: { orgId, number: { not: null } } })).toBe(before);
    expect(await dbInternal.webhookDelivery.count({ where: { orgId, objectId: id } })).toBe(0);
    // Nummer wird beim naechsten Versuch nicht uebersprungen
    const next = await finalizeInvoice(id, { now: NOW });
    expect(next.number).toBeTruthy();
  });

  it("alreadyDone: parallel festgeschriebene Rechnung liefert den Satz des Gewinners ohne zweite Nummer", async () => {
    const id = await draft();
    const host = dbInternal as unknown as TxHost;
    const original = host.$transaction.bind(host);
    let first = true;
    vi.spyOn(host, "$transaction").mockImplementation((fn: TxFn) => {
      if (!first) return original(fn);
      first = false;
      // Der "Gewinner" schreibt fest, der eigene Versuch scheitert mit Kettenkonflikt.
      return original(fn).then(() => {
        throw new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x", meta: { target: ["orgId", "prevHash"] } });
      });
    });
    const before = await dbInternal.invoice.count({ where: { orgId, number: { not: null } } });
    const inv = await finalizeInvoice(id, { now: NOW });
    expect(inv.status).toBe("FINALIZED");
    expect(await dbInternal.invoice.count({ where: { orgId, number: { not: null } } })).toBe(before + 1);
    expect(await dbInternal.changeLog.count({ where: { orgId, entityId: id, action: "FINALIZE" } })).toBe(1);
  });

  it("anderer Fehler wird nicht wiederholt", async () => {
    const id = await draft();
    const host = dbInternal as unknown as TxHost;
    const spy = vi.spyOn(host, "$transaction").mockRejectedValue(new Error("kaputt"));
    await expect(finalizeInvoice(id, { now: NOW })).rejects.toThrow("kaputt");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
