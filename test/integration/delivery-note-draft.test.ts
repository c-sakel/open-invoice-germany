/**
 * Phase 17b, Task 2 — Lieferschein-Entwurf: anlegen (draft:true), bearbeiten, DRAFT -> CREATED
 * (Nummer, Snapshots, Layout-Freeze, Webhook genau einmal, harte Restmengenpruefung),
 * Artikelnummer bei der Konvertierung, Versandsperre fuer Entwuerfe.
 * Eigenes Jahr 2145 (Invoice.number ist global eindeutig).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { createDraftInvoice } from "@/domain/invoice/create";
import { convertDocument } from "@/domain/document/convert";
import { createDeliveryNote, DeliveryNoteError, DeliveryNoteValidationError } from "@/domain/delivery-note/create";
import { updateDraftDeliveryNote, DeliveryNoteNotDraftError } from "@/domain/delivery-note/update";
import { remainingQuantities, OverDeliveryError } from "@/domain/delivery-note/quantities";
import { setDeliveryNoteStatus } from "@/domain/document/status";
import { NotFoundError } from "@/domain/errors";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { saveMailSettings } from "@/domain/email/settings";
import { sendDocumentEmail } from "@/domain/email/send";
import type { MailProvider } from "@/lib/mail/provider";
import type { SendEmailRawInput } from "@/schemas/email";
import type { CreateInvoiceInput } from "@/schemas";

const FIX = new Date("2145-03-02T10:00:00Z");

const item = (description: string, qty: number, extra: Record<string, unknown> = {}) => ({
  lineType: "ITEM" as const, description, quantityMilli: qty, unit: "C62", unitNetPriceCents: 1000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0, discountCents: 0, ...extra,
});

let orgId: string;
let otherOrgId: string;
let customerId: string;
let otherCustomerId: string;
let shippingId: string;
let otherShippingId: string;
let billingId: string;
let contactId: string;
let foreignContactId: string;

async function newQuote(qty = 10000, extra: Record<string, unknown> = {}) {
  const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [item("Kabel", qty, extra)] }, { now: FIX });
  const line = (await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } }));
  return { quote: q, line };
}
const dnLine = (quote: { id: string }, lineId: string, qty: number) => ({ description: "Kabel", quantityMilli: qty, unit: "C62", sourceType: "QUOTE" as const, sourceId: quote.id, sourceLineId: lineId, unitNetPriceCents: 1000, taxRate: 19 });

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({ data: { legalName: "LS-Entwurf GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const customer = await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" } });
  customerId = customer.id;
  const other = await dbInternal.customer.create({ data: { orgId, name: "Zweiter Kunde GmbH", addressLine1: "Weg 5", postalCode: "10115", city: "Berlin", type: "BUSINESS" } });
  otherCustomerId = other.id;
  shippingId = (await dbInternal.customerAddress.create({ data: { orgId, customerId, type: "SHIPPING", addressLine1: "Lager 1", postalCode: "20095", city: "Hamburg", countryCode: "DE" } })).id;
  billingId = (await dbInternal.customerAddress.create({ data: { orgId, customerId, type: "BILLING", addressLine1: "Buchhaltung 1", postalCode: "20095", city: "Hamburg", countryCode: "DE" } })).id;
  otherShippingId = (await dbInternal.customerAddress.create({ data: { orgId, customerId: otherCustomerId, type: "SHIPPING", isDefault: true, addressLine1: "Rampe 9", postalCode: "10115", city: "Berlin", countryCode: "DE" } })).id;
  contactId = (await dbInternal.contactPerson.create({ data: { orgId, customerId, firstName: "Erika", lastName: "Muster" } })).id;
  foreignContactId = (await dbInternal.contactPerson.create({ data: { orgId, customerId: otherCustomerId, firstName: "Hans", lastName: "Fremd" } })).id;
  const o2 = await dbInternal.organization.create({ data: { legalName: "Fremde GmbH", addressLine1: "Andere Str. 1", postalCode: "10115", city: "Berlin" } });
  otherOrgId = o2.id;
});

describe("Lieferschein-Entwurf anlegen", () => {
  it("draft:true -> DRAFT, number null, keine Snapshots, kein Layout-Freeze, ChangeLog CREATE mit status DRAFT, kein Webhook", async () => {
    const ep = await createWebhookEndpoint(orgId, { url: "https://93.184.216.34/hook", events: ["delivery_note.created"] }, { now: FIX });
    const { quote, line } = await newQuote();
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 4000)] }, { now: FIX });
    expect(dn.status).toBe("DRAFT");
    expect(dn.number).toBeNull();
    expect(dn.sellerSnapshotJson).toBeNull();
    expect(dn.buyerSnapshotJson).toBeNull();
    expect(dn.contactSnapshotJson).toBeNull();
    expect(dn.snapshotSource).toBeNull();
    expect(dn.printOptionsJson).toBeNull();
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entity: "DELIVERY_NOTE", entityId: dn.id, action: "CREATE" } });
    expect(JSON.parse(log.diffJson).status).toBe("DRAFT");
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, objectId: dn.id } })).toBe(0);
  });

  it("Entwurf reserviert keine Menge", async () => {
    const { quote, line } = await newQuote(10000);
    await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 10000)] }, { now: FIX });
    const rem = await remainingQuantities(orgId, "QUOTE", quote.id);
    expect(rem[0]!.remainingMilli).toBe(10000);
  });
});

describe("updateDraftDeliveryNote", () => {
  it("ersetzt Positionen und Kopf, ChangeLog UPDATE", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, lines: [{ description: "Alt", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    const upd = await updateDraftDeliveryNote(orgId, dn.id, { notes: "Neu", showPrices: true, lines: [{ description: "Neu A", articleNumber: "A-1", quantityMilli: 2000, unit: "C62" }, { description: "Neu B", quantityMilli: 3000, unit: "C62" }] }, { now: FIX });
    expect(upd.notes).toBe("Neu");
    expect(upd.showPrices).toBe(true);
    expect(upd.lines.map((l) => [l.position, l.description, l.articleNumber])).toEqual([[1, "Neu A", "A-1"], [2, "Neu B", null]]);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entity: "DELIVERY_NOTE", entityId: dn.id, action: "UPDATE" } });
    expect(JSON.parse(log.diffJson).lines).toEqual({ from: 1, to: 2 });
  });

  it("fremder Ansprechpartner / BILLING-Adresse -> Fehler", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, lines: [{ description: "X", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    await expect(updateDraftDeliveryNote(orgId, dn.id, { contactPersonId: foreignContactId })).rejects.toBeInstanceOf(DeliveryNoteError);
    await expect(updateDraftDeliveryNote(orgId, dn.id, { shippingAddressId: billingId })).rejects.toBeInstanceOf(DeliveryNoteValidationError);
    await expect(updateDraftDeliveryNote(orgId, dn.id, { shippingAddressId: otherShippingId })).rejects.toBeInstanceOf(DeliveryNoteError);
  });

  it("Kundenwechsel loest Default-Adresse des neuen Kunden auf", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, shippingAddressId: shippingId, contactPersonId: contactId, lines: [{ description: "X", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    expect(dn.shippingAddressId).toBe(shippingId);
    const upd = await updateDraftDeliveryNote(orgId, dn.id, { customerId: otherCustomerId }, { now: FIX });
    expect(upd.customerId).toBe(otherCustomerId);
    expect(upd.shippingAddressId).toBe(otherShippingId);
    expect(upd.contactPersonId).toBeNull();
  });

  it("Kundenwechsel bei Entwurf mit Quelle -> DeliveryNoteValidationError, Kunde unveraendert", async () => {
    const { quote, line } = await newQuote();
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 1000)] }, { now: FIX });
    await expect(updateDraftDeliveryNote(orgId, dn.id, { customerId: otherCustomerId }, { now: FIX })).rejects.toBeInstanceOf(DeliveryNoteValidationError);
    expect((await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: dn.id }, select: { customerId: true } })).customerId).toBe(customerId);
  });
  it("auf CREATED -> DeliveryNoteNotDraftError", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, lines: [{ description: "X", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    expect(dn.status).toBe("CREATED");
    await expect(updateDraftDeliveryNote(orgId, dn.id, { notes: "x" })).rejects.toBeInstanceOf(DeliveryNoteNotDraftError);
  });

  it("fremde Org -> NotFoundError", async () => {
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, lines: [{ description: "X", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    await expect(updateDraftDeliveryNote(otherOrgId, dn.id, { notes: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DRAFT -> CREATED", () => {
  it("vergibt Nummer, issueDate = now, Snapshots (CREATE), friert Layout ein, Webhook genau einmal", async () => {
    const ep = await createWebhookEndpoint(orgId, { url: "https://93.184.216.35/hook", events: ["delivery_note.created"] }, { now: FIX });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, shippingAddressId: shippingId, contactPersonId: contactId, lines: [{ description: "Kabel", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    const later = new Date("2145-03-05T08:00:00Z");
    const created = await setDeliveryNoteStatus(orgId, dn.id, "CREATED", { now: later });
    expect(created.status).toBe("CREATED");
    expect(created.number).toBeTruthy();
    expect(created.issueDate.toISOString()).toBe(later.toISOString());
    expect(created.snapshotSource).toBe("CREATE");
    expect(created.snapshotAt?.toISOString()).toBe(later.toISOString());
    const buyer = JSON.parse(created.buyerSnapshotJson!);
    expect(buyer.shippingAddress.addressLine1).toBe("Lager 1");
    expect(created.sellerSnapshotJson).toBeTruthy();
    expect(JSON.parse(created.contactSnapshotJson!).lastName).toBe("Muster");
    expect(created.printOptionsJson).toBeTruthy();
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, objectId: dn.id, event: "delivery_note.created" } })).toBe(1);
    // erneuter Wechsel zu CREATED ist ein ungueltiger Uebergang, kein zweites Event
    await expect(setDeliveryNoteStatus(orgId, dn.id, "CREATED", { now: later })).rejects.toThrow();
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, objectId: dn.id } })).toBe(1);
  });

  it("Menge > Restmenge -> OverDeliveryError, Status bleibt DRAFT, keine Nummer verbraucht", async () => {
    const { quote, line } = await newQuote(10000);
    await createDeliveryNote(orgId, { customerId, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 10000)] }, { now: FIX });
    const draft = await createDeliveryNote(orgId, { customerId, draft: true, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 1000)] }, { now: FIX });
    const rangeBefore = await dbInternal.numberRange.findMany({ where: { orgId, docType: "DELIVERY_NOTE" }, select: { id: true, currentValue: true } });
    await expect(setDeliveryNoteStatus(orgId, draft.id, "CREATED", { now: FIX })).rejects.toBeInstanceOf(OverDeliveryError);
    const reloaded = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: draft.id } });
    expect(reloaded.status).toBe("DRAFT");
    expect(reloaded.number).toBeNull();
    expect(await dbInternal.numberRange.findMany({ where: { orgId, docType: "DELIVERY_NOTE" }, select: { id: true, currentValue: true } })).toEqual(rangeBefore);
  });
});

describe("direkte Anlage mit Quellbezug", () => {
  it("sourceLineId ueber Restmenge -> OverDeliveryError", async () => {
    const { quote, line } = await newQuote(5000);
    await expect(createDeliveryNote(orgId, { customerId, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 6000)] }, { now: FIX })).rejects.toBeInstanceOf(OverDeliveryError);
  });

  it("Kunde passt nicht zur Quelle -> DeliveryNoteValidationError (Entwurf und direkte Anlage)", async () => {
    const { quote, line } = await newQuote();
    for (const draft of [true, false]) {
      await expect(
        createDeliveryNote(orgId, { customerId: otherCustomerId, draft, sourceType: "QUOTE", sourceId: quote.id, lines: [dnLine(quote, line.id, 1000)] }, { now: FIX }),
      ).rejects.toBeInstanceOf(DeliveryNoteValidationError);
    }
  });

  it("sourceLineId einer fremden Quelle -> OverDeliveryError 'unbekannt'", async () => {
    const a = await newQuote(5000);
    const b = await newQuote(5000);
    await expect(createDeliveryNote(orgId, { customerId, sourceType: "QUOTE", sourceId: a.quote.id, lines: [dnLine(a.quote, b.line.id, 1000)] }, { now: FIX })).rejects.toThrow(/unbekannt/);
  });
});

describe("Artikelnummer bei der Konvertierung", () => {
  it("uebernimmt articleNumber aus QuoteLine und InvoiceLine", async () => {
    const { quote } = await newQuote(3000, { articleNumber: "ART-Q-1" });
    const dnQ = await convertDocument(orgId, { fromType: "QUOTE", fromId: quote.id, toKind: "DELIVERY_NOTE" }, { now: FIX });
    expect((await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dnQ.id } })).articleNumber).toBe("ART-Q-1");

    const inv = await createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0, lines: [item("Rohr", 2000, { articleNumber: "ART-I-7" })] } as CreateInvoiceInput, { now: FIX });
    const dnI = await convertDocument(orgId, { fromType: "INVOICE", fromId: inv.id, toKind: "DELIVERY_NOTE" }, { now: FIX });
    expect((await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dnI.id } })).articleNumber).toBe("ART-I-7");
  });
});

describe("Versand", () => {
  it("Lieferschein-Entwurf wird abgelehnt, kein EmailLog, SMTP nie aufgerufen", async () => {
    await saveMailSettings(orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Test GmbH", fromEmail: "rechnung@example.org", defaultBcc: "", copyToSelf: false, defaultCc: "" });
    const dn = await createDeliveryNote(orgId, { customerId, draft: true, lines: [{ description: "X", quantityMilli: 1000, unit: "C62" }] }, { now: FIX });
    let calls = 0;
    const provider: MailProvider = { send: async () => { calls++; return { providerId: null }; } };
    const input: SendEmailRawInput = { docType: "DELIVERY_NOTE", docId: dn.id, to: "kunde@example.org", cc: "", bcc: "", subject: "Lieferschein", body: "Anbei", signature: "", copyToSelf: false, standardAttachments: [], warnings: [] };
    const before = await dbInternal.emailLog.count({ where: { orgId } });
    await expect(sendDocumentEmail(orgId, "system", input, [], provider)).rejects.toBeInstanceOf(DeliveryNoteValidationError);
    expect(calls).toBe(0);
    expect(await dbInternal.emailLog.count({ where: { orgId } })).toBe(before);
  });
});
