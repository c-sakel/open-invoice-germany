/**
 * Verzug am ersten Zinstag: Grund bleibt gespeichert, keine Zinstage, Pauschale gebucht. Testjahr 2312.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createDunning } from "@/domain/dunning/create";
import { upsertBaseRate } from "@/domain/dunning/base-rate";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { listDunningStages, updateDunningStage } from "@/domain/dunning/stages";
import type { CreateInvoiceInput } from "@/schemas";

const U = (m: number, d: number, h = 12, min = 0) => new Date(Date.UTC(2312, m - 1, d, h, min));

let orgId = "";
let n = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Zinstag Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999999", taxNumber: "1" },
  });
  orgId = org.id;
  orgStore.id = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await upsertBaseRate(orgId, { validFrom: "2312-01-01", rateBp: 200, source: "Test" });
  const s0 = (await listDunningStages(orgId)).find((s) => s.order === 0)!;
  const { id, ...rest } = s0;
  void id;
  await updateDunningStage(orgId, s0.id, { ...rest, calculateInterest: true, includeB2BFlatFee: true });
});

async function overdueInvoice() {
  n += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Zinstag ${n}`, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const draft = await createDraftInvoice(orgId, {
    customerId: c.id,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: U(1, 2),
    dueDate: U(1, 5, 0),
    lines: [{ description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput);
  const fin = await finalizeInvoice(draft.id, { now: U(1, 2) });
  await dbInternal.emailLog.create({ data: { orgId, docType: "INVOICE", docId: fin.id, subject: "x", bodySnapshot: "x", status: "SENT", sentAt: U(1, 3) } });
  return fin;
}


// Rechnung Versand 03.01. (Zugang 04.01.), faellig 05.01. -> Fristende 04.02. (Sonntag) -> 05.02. (Montag), Verzug 05.02., erster Zinstag 06.02.
describe("Mahnung am Verzugstag ohne Zinstage", () => {
  it("Mahnung am 05.02.: Grund gespeichert, interestFrom null, 0 Zinsen, Pauschale gebucht", async () => {
    const a = await overdueInvoice();
    const r = await createDunning(a.id, { now: U(2, 5, 12), force: true });
    expect(r.dunning.interestBasis).toBe("ENTGELT_30");
    expect(r.dunning.interestFrom).toBeNull();
    expect(r.dunning.interestAmountCents).toBe(0);
    expect(r.dunning.flatFee40Cents).toBe(4000);
  });

  it("Mahnung am 04.02. (Verzug erst morgen): NONE, keine Pauschale", async () => {
    const a = await overdueInvoice();
    const r = await createDunning(a.id, { now: U(2, 4, 12), force: true });
    expect(r.dunning.interestBasis).toBe("NONE");
    expect(r.dunning.interestFrom).toBeNull();
    expect(r.dunning.flatFee40Cents).toBe(0);
  });

  it("Mahnung am 07.02.: Zinsen ab 06.02. mit Grund (Regression)", async () => {
    const a = await overdueInvoice();
    const r = await createDunning(a.id, { now: U(2, 7, 12), force: true });
    expect(r.dunning.interestBasis).toBe("ENTGELT_30");
    expect(r.dunning.interestFrom?.toISOString().slice(0, 10)).toBe("2312-02-06");
    expect(r.dunning.interestAmountCents).toBeGreaterThan(0);
  });
});
