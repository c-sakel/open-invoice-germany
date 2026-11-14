/**
 * Phase 18c Fix-Welle 1: Wiederholung des Sammel-Stornos nur bei ChangeLog-Kettenkonflikt,
 * Ergebnisbericht auch wenn das Aktivitaetsprotokoll scheitert. Fehler werden ueber die schmalen
 * Optionen cancel/log/sleepMs injiziert; Belege und Datenbank sind echt. Eigenes Testjahr 2174.
 */
import { beforeAll, describe, it, expect, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { cancelInvoicesBulk } from "@/domain/invoice/bulk-cancel";
import { createInvoiceSchema } from "@/schemas";

const NOW = new Date("2174-05-01T10:00:00.000Z");
const now = () => NOW;
const noSleep = async () => {};

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammelretry GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE555666779", taxNumber: "55/666/77778" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  orgId = org.id;
  customerId = (await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  })).id;
});

async function finalized() {
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", deliveryDate: NOW,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  return finalizeInvoice(d.id, { now: NOW });
}

const p2002 = (target: string[]) => new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x", meta: { target } });

describe("cancelInvoicesBulk Wiederholung und Protokoll", () => {
  it("P2002 ohne prevHash -> INTERNAL, keine Wiederholung, Rohfehler nicht im Log", async () => {
    const inv = await finalized();
    const cancel = vi.fn(async () => { throw p2002(["number"]); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await cancelInvoicesBulk(orgId, { ids: [inv.id], reason: "Test" }, { now, cancel, sleepMs: noSleep });
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].code).toBe("INTERNAL");
    expect(logged).toContain("P2002");
    expect(logged).not.toContain("Unique");
  });

  it("Kettenkonflikt 3x -> BUSY nach drei Versuchen", async () => {
    const inv = await finalized();
    const cancel = vi.fn(async () => { throw p2002(["orgId", "prevHash"]); });
    const r = await cancelInvoicesBulk(orgId, { ids: [inv.id], reason: "Test" }, { now, cancel, sleepMs: noSleep });
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(r.failed[0].code).toBe("BUSY");
    expect(r.ok).toHaveLength(0);
  });

  it("Kettenkonflikt im 1. Versuch, Erfolg im 2. -> ok", async () => {
    const inv = await finalized();
    let calls = 0;
    const cancel: typeof cancelInvoice = async (id, o) => {
      calls += 1;
      if (calls === 1) throw p2002(["orgId", "prevHash"]);
      return cancelInvoice(id, o);
    };
    const r = await cancelInvoicesBulk(orgId, { ids: [inv.id], reason: "Test" }, { now, cancel, sleepMs: noSleep });
    expect(calls).toBe(2);
    expect(r.failed).toHaveLength(0);
    expect(r.ok).toHaveLength(1);
  });

  it("logActivity wirft -> Ergebnisbericht kommt trotzdem", async () => {
    const inv = await finalized();
    const log = vi.fn(async () => { throw new Error("Protokoll kaputt Belegdaten"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await cancelInvoicesBulk(orgId, { ids: [inv.id], reason: "Test" }, { now, log, sleepMs: noSleep });
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(log).toHaveBeenCalledTimes(1);
    expect(r.ok).toHaveLength(1);
    expect(logged).not.toContain("Belegdaten");
  });
});
