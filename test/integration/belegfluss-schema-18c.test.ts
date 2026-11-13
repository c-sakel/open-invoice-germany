/**
 * Phase 18c, Task 1 — Schema: Abo-Positionsbloecke (RecurringInvoiceLine) und HTML-Schalter (MailSettings).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";

let orgId = "";
let recurringId = "";

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Belegfluss-Schema GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Abo-Kunde", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  const rec = await dbInternal.recurringInvoice.create({
    data: { orgId, customerId: customer.id, title: "Abo 18c", startDate: new Date(), nextRunDate: new Date() },
    select: { id: true },
  });
  recurringId = rec.id;
});

describe("Schema Phase 18c", () => {
  it("Abo-Zeile nur mit Altfeldern: ITEM, kein Rabatt, Snapshot-Felder null", async () => {
    const line = await dbInternal.recurringInvoiceLine.create({
      data: { recurringInvoiceId: recurringId, position: 1, description: "Altposition", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 },
      select: { lineType: true, discountCents: true, productId: true, descriptionLong: true, articleNumber: true },
    });
    expect(line).toEqual({ lineType: "ITEM", discountCents: 0, productId: null, descriptionLong: null, articleNumber: null });
  });

  it("HEADING-Zeile mit Langtext ist speicherbar", async () => {
    const line = await dbInternal.recurringInvoiceLine.create({
      data: {
        recurringInvoiceId: recurringId, position: 2, description: "Abschnitt", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0,
        lineType: "HEADING", descriptionLong: "**Hinweis**", articleNumber: "A-1", productId: "prod-x", discountCents: 250,
      },
      select: { lineType: true, descriptionLong: true, articleNumber: true, productId: true, discountCents: true },
    });
    expect(line).toEqual({ lineType: "HEADING", descriptionLong: "**Hinweis**", articleNumber: "A-1", productId: "prod-x", discountCents: 250 });
  });

  it("MailSettings: htmlEnabled Default false, true lesbar", async () => {
    const ms = await dbInternal.mailSettings.create({
      data: { orgId, host: "smtp.example.org", port: 587, security: "STARTTLS", fromName: "Test", fromEmail: "t18c@example.org" },
      select: { htmlEnabled: true },
    });
    expect(ms.htmlEnabled).toBe(false);
    const upd = await dbInternal.mailSettings.update({ where: { orgId }, data: { htmlEnabled: true }, select: { htmlEnabled: true } });
    expect(upd.htmlEnabled).toBe(true);
  });
});
