import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { buildTemplateContext, DocumentNotFoundError } from "@/domain/email/context";
import { buildStandardAttachments } from "@/domain/email/attachments";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let otherOrgId: string;
let customerId: string;
const FIX_DATE = new Date("2029-06-09T10:00:00.000Z"); // eigenes Jahr, um Nummernkreis-Kollisionen mit anderen Testdateien zu vermeiden

function baseInput(extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2026-06-01"),
    lines: [
      { description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 },
    ],
    ...extra,
  } as CreateInvoiceInput;
}

/** Prueft rekursiv, dass kein Schluessel "internalNotes" im Kontext auftaucht. */
function assertNoInternalNotes(value: unknown, path = "ctx"): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    expect(key).not.toBe("internalNotes");
    assertNoInternalNotes(v, `${path}.${key}`);
  }
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Kontext-Test GmbH",
      addressLine1: "Teststr. 2",
      postalCode: "10115",
      city: "Berlin",
      email: "buero@kontext-test.example",
      iban: "DE12500105170648489890",
      bic: "INGDDEFFXXX",
      vatId: "DE123456789",
      taxNumber: "33/123/45678",
    },
  });
  orgId = org.id;

  const other = await dbInternal.organization.create({
    data: { legalName: "Fremd GmbH", addressLine1: "Fremdweg 1", postalCode: "99999", city: "Nirgendwo" },
  });
  otherOrgId = other.id;

  const customer = await dbInternal.customer.create({
    data: {
      orgId,
      name: "Kunde AG",
      contactName: "Erika Musterfrau",
      addressLine1: "Marktplatz 2",
      postalCode: "20095",
      city: "Hamburg",
      type: "BUSINESS",
      email: "einkauf@kunde-ag.example",
      leitwegId: "04011000-12345-67",
    },
  });
  customerId = customer.id;
});

afterAll(async () => {
  await dbInternal.$disconnect();
});

describe("buildTemplateContext / buildStandardAttachments — Rechnung", () => {
  it("Entwurf: Kontext korrekt, Anhang ist das ENTWURF-PDF, interne Notiz taucht nicht auf", async () => {
    const draft = await createDraftInvoice(orgId, baseInput({ internalNotes: "Streng vertrauliche interne Notiz" }));

    const { ctx, customerEmail, docNumber } = await buildTemplateContext(orgId, "INVOICE", draft.id);
    expect(docNumber).toBe("ENTWURF");
    expect(customerEmail).toBe("einkauf@kunde-ag.example");
    const document = ctx.document as { number: string; total: string };
    expect(document.number).toBe("");
    expect(document.total.endsWith(" €")).toBe(true);
    assertNoInternalNotes(ctx);

    const attachments = await buildStandardAttachments(orgId, "INVOICE", draft.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toMatch(/-ENTWURF\.pdf$/);
    expect(attachments[0]!.content.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("festgeschrieben mit Leitweg-ID: PDF + XRechnung-XML, Kontext mit Rechnungsnummer", async () => {
    const draft = await createDraftInvoice(orgId, baseInput());
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });

    const { ctx, docNumber } = await buildTemplateContext(orgId, "INVOICE", finalized.id);
    expect(docNumber).toBe(finalized.number);
    const document = ctx.document as { number: string; total: string };
    expect(document.number).toBe(finalized.number);
    expect(document.total.endsWith(" €")).toBe(true);
    assertNoInternalNotes(ctx);

    const attachments = await buildStandardAttachments(orgId, "INVOICE", finalized.id);
    expect(attachments).toHaveLength(2);
    const pdf = attachments.find((a) => a.filename.endsWith(".pdf"))!;
    const xml = attachments.find((a) => a.filename.endsWith(".xml"))!;
    expect(pdf.filename).toBe(`${finalized.number}.pdf`);
    expect(pdf.content.subarray(0, 4).toString()).toBe("%PDF");
    expect(xml.filename).toBe(`${finalized.number}-xrechnung.xml`);
    expect(xml.content.subarray(0, 5).toString()).toBe("<?xml");
  });

  it("Kunde ohne Leitweg-ID: nur PDF, keine XRechnung", async () => {
    const customerOhneLeitweg = await dbInternal.customer.create({
      data: { orgId, name: "Kunde ohne Leitweg", addressLine1: "Weg 1", postalCode: "10000", city: "Berlin", type: "BUSINESS", email: "ohne@example.com" },
    });
    const draft = await createDraftInvoice(orgId, baseInput({ customerId: customerOhneLeitweg.id }));
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });

    const attachments = await buildStandardAttachments(orgId, "INVOICE", finalized.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename.endsWith(".pdf")).toBe(true);
  });

  it("fremde orgId: DocumentNotFoundError im Kontext, leeres Array bei Anhaengen", async () => {
    const draft = await createDraftInvoice(orgId, baseInput());
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });

    await expect(buildTemplateContext(otherOrgId, "INVOICE", finalized.id)).rejects.toBeInstanceOf(DocumentNotFoundError);
    const attachments = await buildStandardAttachments(otherOrgId, "INVOICE", finalized.id);
    expect(attachments).toEqual([]);
  });
});
