/**
 * Abo-Waehrungskette: Eingabe > Kundenvorgabe > DocumentSettings.defaultCurrency > EUR,
 * Aenderung ueber updateRecurringInvoice, Uebernahme in die erzeugte Rechnung.
 * Eigenes Jahr 2081 (Invoice.number global eindeutig; Entwuerfe ohne Nummer).
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { emitRecurringInvoice as emitRecurringNow } from "../helpers/emit-recurring";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createRecurringSchema, updateRecurringSchema, type CreateRecurringInput } from "@/schemas";

let orgId: string;
let usdCustomerId: string;
let plainCustomerId: string;

const lines = [{ description: "Wartung", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }];
function input(customerId: string, extra: Partial<CreateRecurringInput> = {}): CreateRecurringInput {
  return createRecurringSchema.parse({ customerId, title: "Abo", startDate: new Date("2081-03-01T10:00:00.000Z"), lines, ...extra });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Abo-Waehrung GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const base = { orgId, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" as const };
  usdCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "USD-Kunde", defaultCurrency: "USD" } })).id;
  plainCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "Plain-Kunde" } })).id;
});

describe("createRecurring: Waehrungskette", () => {
  it("Kunde mit USD ohne Angabe -> Abo USD -> erzeugte Rechnung USD", async () => {
    const rec = await createRecurring(orgId, input(usdCustomerId));
    expect(rec.currency).toBe("USD");
    const emitted = await emitRecurringNow(rec.id, { now: new Date("2081-03-01T10:00:00.000Z") });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId }, select: { currency: true } });
    expect(inv.currency).toBe("USD");
  });

  it("explizite Angabe ueberstimmt die Kundenvorgabe", async () => {
    const rec = await createRecurring(orgId, input(usdCustomerId, { currency: "GBP" }));
    expect(rec.currency).toBe("GBP");
  });

  it("ohne Kundenvorgabe: Einstellung, sonst EUR", async () => {
    expect((await createRecurring(orgId, input(plainCustomerId))).currency).toBe("EUR");
    await saveDocumentSettings(orgId, { defaultCurrency: "CHF" });
    expect((await createRecurring(orgId, input(plainCustomerId))).currency).toBe("CHF");
    expect((await createRecurring(orgId, input(usdCustomerId))).currency).toBe("USD");
  });

  it("ungueltiger Code wird vom Schema abgelehnt, Kleinschreibung wird normalisiert", () => {
    expect(() => input(plainCustomerId, { currency: "US1" })).toThrow();
    expect(updateRecurringSchema.safeParse({ currency: "EURO" }).success).toBe(false);
    expect(updateRecurringSchema.parse({ currency: "usd" }).currency).toBe("USD");
    expect(updateRecurringSchema.safeParse({ currency: "USD" }).success).toBe(true);
  });
});

describe("updateRecurringInvoice: currency", () => {
  it("aendert die Waehrung und schreibt einen Activity-Eintrag", async () => {
    const rec = await createRecurring(orgId, input(plainCustomerId));
    const updated = await updateRecurringInvoice(orgId, rec.id, { currency: "SEK" }, "test");
    expect(updated.currency).toBe("SEK");
    const act = await dbInternal.activityLog.findFirst({ where: { orgId, entityType: "RECURRING", entityId: rec.id, type: "UPDATED" }, select: { id: true } });
    expect(act).not.toBeNull();
  });

  it("ohne currency bleibt der Bestandswert", async () => {
    const rec = await createRecurring(orgId, input(usdCustomerId, { currency: "NOK" }));
    const updated = await updateRecurringInvoice(orgId, rec.id, { title: "Neu" }, "test");
    expect(updated.currency).toBe("NOK");
  });
});
