/**
 * Sammelrechnung: Abo-Felder (Schalter, Blockueberschrift) und Positionsherkunft im
 * Rechnungspfad. Nur Entwuerfe, keine Belegnummer vergeben.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring, RecurringError } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { createInvoiceSchema, createRecurringSchema } from "@/schemas";

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammel Felder GmbH", addressLine1: "Weg 2", postalCode: "99902", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Felder Kunde", addressLine1: "Kundenweg 2", postalCode: "99902", city: "Teststadt", countryCode: "DE" },
    select: { id: true },
  });
  customerId = c.id;
});

const recLine = { description: "Paket", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19 };

function recurringInput(extra: Record<string, unknown> = {}) {
  return createRecurringSchema.parse({ customerId, title: "Abo", startDate: "2205-01-01", lines: [recLine], ...extra });
}

function invoiceInput(count: number) {
  return createInvoiceSchema.parse({
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    lines: Array.from({ length: count }, (_, i) => ({
      description: `Pos ${i + 1}`, unit: "C62", quantityMilli: 1000, unitNetPriceCents: 1000 + i, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0,
    })),
  });
}

describe("Abo-Felder Sammelrechnung", () => {
  it("Anlegen mit Schalter und Ueberschrift speichert beide", async () => {
    const r = await createRecurring(orgId, recurringInput({ collectiveBilling: true, invoiceHeading: "Hosting" }));
    expect(r.collectiveBilling).toBe(true);
    expect(r.invoiceHeading).toBe("Hosting");
  });

  it("Anlegen mit Schalter ohne Ueberschrift (an Zod vorbei) -> RecurringError", async () => {
    const input = { ...recurringInput(), collectiveBilling: true };
    await expect(createRecurring(orgId, input)).rejects.toBeInstanceOf(RecurringError);
  });

  it("Anlegen ohne Angabe: Schalter aus, keine Ueberschrift", async () => {
    const r = await createRecurring(orgId, recurringInput());
    expect(r.collectiveBilling).toBe(false);
    expect(r.invoiceHeading).toBeNull();
  });

  it("Update: Schalter an ohne Ueberschrift -> RecurringError, mit Ueberschrift im Patch ok", async () => {
    const r = await createRecurring(orgId, recurringInput());
    await expect(updateRecurringInvoice(orgId, r.id, { collectiveBilling: true })).rejects.toBeInstanceOf(RecurringError);
    const ok = await updateRecurringInvoice(orgId, r.id, { collectiveBilling: true, invoiceHeading: "Domain" });
    expect(ok.collectiveBilling).toBe(true);
    expect(ok.invoiceHeading).toBe("Domain");
  });

  it("Update: Ueberschrift null bei aktivem Schalter -> Fehler; Schalter aus, Ueberschrift bleibt gespeichert", async () => {
    const r = await createRecurring(orgId, recurringInput({ collectiveBilling: true, invoiceHeading: "Block" }));
    await expect(updateRecurringInvoice(orgId, r.id, { invoiceHeading: null })).rejects.toBeInstanceOf(RecurringError);
    const off = await updateRecurringInvoice(orgId, r.id, { collectiveBilling: false });
    expect(off.collectiveBilling).toBe(false);
    expect(off.invoiceHeading).toBe("Block");
    const cleared = await updateRecurringInvoice(orgId, r.id, { invoiceHeading: null });
    expect(cleared.invoiceHeading).toBeNull();
  });
});

describe("Positionsherkunft im Rechnungspfad", () => {
  it("lineRecurringIds landet je Position, ohne Option alle null", async () => {
    const rec = await createRecurring(orgId, recurringInput());
    const withIds = await dbInternal.$transaction((tx) =>
      createDraftInvoiceWithinTx(tx, orgId, invoiceInput(3), { lineRecurringIds: [rec.id, null, rec.id] }),
    );
    expect(withIds.lines.map((l) => l.recurringInvoiceId)).toEqual([rec.id, null, rec.id]);
    const without = await dbInternal.$transaction((tx) => createDraftInvoiceWithinTx(tx, orgId, invoiceInput(2)));
    expect(without.lines.map((l) => l.recurringInvoiceId)).toEqual([null, null]);
  });

  it("falsche Laenge -> Fehler", async () => {
    await expect(
      dbInternal.$transaction((tx) => createDraftInvoiceWithinTx(tx, orgId, invoiceInput(2), { lineRecurringIds: [null] })),
    ).rejects.toThrow(/lineRecurringIds/);
  });

  it("Entwurf-Update nur Belegrabatt behaelt Herkunft, mit neuen Positionen null", async () => {
    const rec = await createRecurring(orgId, recurringInput());
    const draft = await dbInternal.$transaction((tx) =>
      createDraftInvoiceWithinTx(tx, orgId, invoiceInput(2), { lineRecurringIds: [rec.id, rec.id] }),
    );
    const discounted = await updateDraftInvoice(orgId, draft.id, { documentDiscountPermille: 50 }, "test");
    expect(discounted.lines.map((l) => l.recurringInvoiceId)).toEqual([rec.id, rec.id]);
    const replaced = await updateDraftInvoice(orgId, draft.id, { lines: invoiceInput(2).lines }, "test");
    expect(replaced.lines.map((l) => l.recurringInvoiceId)).toEqual([null, null]);
  });
});
