/**
 * Phase 16b, Task 7: Belegsprache als Snapshot (Customer.language -> Beleg), Vorlagenwahl
 * je Sprache (Mail-/Textvorlagen: Belegsprache, dann de) und englische Systemvorlagen.
 * Eigenes Testjahr 2110 (Invoice.number ist global @unique).
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata, ensureOrgEmailTemplates } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { convertDocument } from "@/domain/document/convert";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringNow } from "@/domain/recurring/run";
import { createDunning } from "@/domain/dunning/create";
import { prefillEmail } from "@/domain/email/compose";
import { saveMailSettings } from "@/domain/email/settings";
import { pickTextTemplate } from "@/domain/text-template/pick";
import { createRecurringSchema, createInvoiceSchema, updateInvoiceSchema } from "@/schemas";

let orgId: string;
let enCustomerId: string;
let frCustomerId: string;
let deCustomerId: string;

const NOW = new Date("2110-03-10T10:00:00.000Z");
const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

function invoiceInput(customerId: string, extra: Record<string, unknown> = {}) {
  return createInvoiceSchema.parse({ customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", deliveryDate: new Date("2110-03-01"), lines: [line], ...extra });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sprache GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678", email: "org@example.org" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const base = { orgId, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" as const, email: "k@example.org" };
  enCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "EN-Kunde", language: "en" } })).id;
  frCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "FR-Kunde", language: "fr" } })).id;
  deCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "DE-Kunde" } })).id;
  await saveMailSettings(orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Sprache GmbH", fromEmail: "r@example.org", defaultBcc: "", copyToSelf: false, defaultCc: "" });
});

afterAll(async () => {
  await dbInternal.$disconnect();
});

describe("Belegsprache aus dem Kunden", () => {
  it("Rechnung, Angebot und Lieferschein eines en-Kunden sind en; unbekannte Sprache -> de", async () => {
    const inv = await createDraftInvoice(orgId, invoiceInput(enCustomerId), { now: NOW });
    expect(inv.language).toBe("en");
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId: enCustomerId, lines: [line] }, { now: NOW });
    expect(quote.language).toBe("en");
    const dn = await createDeliveryNote(orgId, { customerId: enCustomerId, lines: [{ description: "Ware", quantityMilli: 1000, unit: "C62" }] }, { now: NOW });
    expect(dn.language).toBe("en");
    const fr = await createDraftInvoice(orgId, invoiceInput(frCustomerId), { now: NOW });
    expect(fr.language).toBe("de");
  });

  it("explizites language 'de' schlaegt die Kundensprache", async () => {
    const inv = await createDraftInvoice(orgId, invoiceInput(enCustomerId, { language: "de" }), { now: NOW });
    expect(inv.language).toBe("de");
  });

  it("englische Textvorlagen werden fuer en-Belege vorbelegt, deutsche bleiben unveraendert", async () => {
    const en = await createDraftInvoice(orgId, invoiceInput(enCustomerId), { now: NOW });
    expect(en.headerText).toBe("We would like to invoice you for the following services:");
    const de = await createDraftInvoice(orgId, invoiceInput(deCustomerId), { now: NOW });
    expect(de.headerText).toBe("Wir erlauben uns, folgende Leistungen in Rechnung zu stellen:");
  });

  it("Angebot en -> umgewandelte Rechnung en", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId: enCustomerId, lines: [line] }, { now: NOW });
    const res = await convertDocument(orgId, { fromType: "QUOTE", fromId: quote.id, toKind: "INVOICE" }, { now: NOW });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: res.id }, select: { language: true } });
    expect(inv.language).toBe("en");
  });

  it("Abo eines en-Kunden -> erzeugte Rechnung en", async () => {
    const rec = await createRecurring(orgId, createRecurringSchema.parse({ customerId: enCustomerId, title: "Abo", startDate: NOW, lines: [line] }));
    expect(rec.language).toBe("en");
    const emitted = await emitRecurringNow(rec.id, { now: NOW });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId }, select: { language: true } });
    expect(inv.language).toBe("en");
  });

  it("Aenderung der Kundensprache aendert bestehende Belege nicht", async () => {
    const inv = await createDraftInvoice(orgId, invoiceInput(deCustomerId), { now: NOW });
    await dbInternal.customer.update({ where: { id: deCustomerId }, data: { language: "en" } });
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { language: true } });
    expect(after.language).toBe("de");
    await dbInternal.customer.update({ where: { id: deCustomerId }, data: { language: "de" } });
  });
});

describe("Sprache aendern", () => {
  it("im Entwurf aenderbar", async () => {
    const inv = await createDraftInvoice(orgId, invoiceInput(deCustomerId), { now: NOW });
    const upd = await updateDraftInvoice(orgId, inv.id, updateInvoiceSchema.parse({ language: "en" }), "tester");
    expect(upd.language).toBe("en");
  });

  it("auf festgeschriebener Rechnung abgewiesen, nichts geschrieben", async () => {
    const draft = await createDraftInvoice(orgId, invoiceInput(deCustomerId), { now: NOW });
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    await expect(updateDraftInvoice(orgId, fin.id, { language: "en" }, "tester")).rejects.toThrow();
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { language: true } });
    expect(row.language).toBe("de");
  });

  it("ungueltiger Sprachcode wird vom Schema abgewiesen", () => {
    expect(updateInvoiceSchema.safeParse({ language: "fr" }).success).toBe(false);
  });
});

describe("Mailvorlagen je Sprache", () => {
  it("en-Rechnung -> englische Systemvorlage; ohne en-Vorlage -> deutsche Default-Vorlage", async () => {
    const draft = await createDraftInvoice(orgId, invoiceInput(enCustomerId), { now: NOW });
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: fin.id });
    const tpl = await dbInternal.emailTemplate.findUniqueOrThrow({ where: { id: pre.templateId! } });
    expect(tpl.language).toBe("en");
    expect(tpl.isSystem).toBe(true);
    expect(pre.subject).toContain("Invoice");

    await dbInternal.emailTemplate.deleteMany({ where: { orgId, docType: "INVOICE", language: "en" } });
    const pre2 = await prefillEmail(orgId, { docType: "INVOICE", docId: fin.id });
    const tpl2 = await dbInternal.emailTemplate.findUniqueOrThrow({ where: { id: pre2.templateId! } });
    expect(tpl2.language).toBe("de");
    expect(tpl2.isDefault).toBe(true);
    await ensureOrgEmailTemplates(dbInternal, orgId); // en-Systemvorlage wieder anlegen
  });

  it("deutsche Rechnung bleibt bei der deutschen Vorlage", async () => {
    const draft = await createDraftInvoice(orgId, invoiceInput(deCustomerId), { now: NOW });
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: fin.id });
    expect(pre.subject).toBe(`Rechnung ${fin.number} von Sprache GmbH`);
  });

  it("Mahnung en: gleichnamige en-Vorlage, sonst en-Default, sonst deutsche Stufenvorlage", async () => {
    const draft = await createDraftInvoice(orgId, invoiceInput(enCustomerId, { dueDate: new Date("2110-03-11") }), { now: NOW });
    const fin = await finalizeInvoice(draft.id, { now: NOW });
    const { dunning } = await createDunning(fin.id, { now: new Date("2110-04-20T10:00:00.000Z") });
    expect(dunning.language).toBe("en");

    const pick = async () => dbInternal.emailTemplate.findUniqueOrThrow({ where: { id: (await prefillEmail(orgId, { docType: "DUNNING", docId: dunning.id })).templateId! } });
    expect((await pick()).language).toBe("en");

    // gleichnamige en-Vorlage zur Stufe (Name der Stufe) hat Vorrang
    const named = await dbInternal.emailTemplate.create({
      data: { orgId, docType: "DUNNING", language: "en", name: dunning.stageId ? (await dbInternal.dunningStage.findUniqueOrThrow({ where: { id: dunning.stageId } })).name : "x", subject: "S", body: "B" },
    });
    expect((await pick()).id).toBe(named.id);
    await dbInternal.emailTemplate.delete({ where: { id: named.id } });

    // en-Default (ohne gleichnamige/Stufen-en-Vorlage)
    await dbInternal.emailTemplate.deleteMany({ where: { orgId, docType: "DUNNING", language: "en" } });
    const enDefault = await dbInternal.emailTemplate.create({ data: { orgId, docType: "DUNNING", language: "en", name: "Mein Default", subject: "S", body: "B", isDefault: true } });
    expect((await pick()).id).toBe(enDefault.id);
    await dbInternal.emailTemplate.delete({ where: { id: enDefault.id } });

    // keine en-Vorlage -> deutsche Stufenvorlage
    expect((await pick()).language).toBe("de");
    await ensureOrgEmailTemplates(dbInternal, orgId);
  });
});

describe("Textvorlagen und Seeding", () => {
  it("pickTextTemplate(..., 'en') ohne englische Vorlage -> deutscher Text", async () => {
    await dbInternal.textTemplate.deleteMany({ where: { orgId, docType: "ANGEBOT", position: "HEAD", language: "en" } });
    expect(await pickTextTemplate(dbInternal, orgId, "ANGEBOT", "HEAD", "en")).toBe("Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:");
    expect(await pickTextTemplate(dbInternal, orgId, "INVOICE", "FOOT", "en")).toBe("Thank you for your order.");
  });

  it("ensureOrgEmailTemplates zweimal: keine Duplikate, je docType genau ein Default je Sprache", async () => {
    const before = await dbInternal.emailTemplate.count({ where: { orgId } });
    await ensureOrgEmailTemplates(dbInternal, orgId);
    await ensureOrgEmailTemplates(dbInternal, orgId);
    expect(await dbInternal.emailTemplate.count({ where: { orgId } })).toBe(before);
    for (const language of ["de", "en"]) {
      for (const docType of ["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA", "DELIVERY_NOTE", "INVOICE", "CREDIT_NOTE"]) {
        expect(await dbInternal.emailTemplate.count({ where: { orgId, docType, language, isDefault: true } })).toBe(1);
      }
    }
    expect(await dbInternal.emailTemplate.count({ where: { orgId, docType: "DUNNING", language: "en", isSystem: true } })).toBe(4);
  });
});
