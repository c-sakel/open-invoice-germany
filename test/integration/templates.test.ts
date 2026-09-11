/**
 * Phase 13d, Task 3 — Vorlagen-Domain (src/domain/template/{save,apply,list}.ts).
 *
 * Kernpunkte (task-3-brief.md, koordinator-nachtrag.md): `saveTemplateFromDocument`
 * liest AUSSCHLIESSLICH den gespeicherten Beleg und schreibt den Payload OHNE
 * Belegnummer, Datum, Snapshots, Zahlungen oder interne Notizen (§48).
 * `applyTemplate` erzeugt Entwuerfe AUSSCHLIESSLICH ueber createDraftInvoice/
 * createBusinessDocument/createDeliveryNote — dieselbe Zod-Validierung, dieselbe
 * Steuersatz-Pruefung (assertAllowedTaxRates, kein Bypass ueber einen geerbten Satz).
 *
 * Testjahr 2090 (Testjahr-Konvention). EIN gemeinsamer Org fuer die meisten Tests
 * (Muster test/integration/tags.test.ts), orgB nur fuer Org-Isolation, orgRates nur fuer
 * den Steuersatz-Test (aendert org-weite Einstellungen dauerhaft).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createInvoiceSchema, type CreateInvoiceInput, type CreateDocumentInput } from "@/schemas";
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";
import { TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import { saveTemplateFromDocument, deleteTemplate, renameTemplate, TemplateNameConflictError } from "@/domain/template/save";
import { applyTemplate, TemplateCustomerRequiredError } from "@/domain/template/apply";
import { listTemplates } from "@/domain/template/list";
import { documentTemplatePayloadSchema } from "@/schemas/template";
import { NotFoundError } from "@/domain/errors";

const FIX_DATE = new Date("2090-06-10T10:00:00.000Z");

let orgId: string;
let orgB: string;
let orgRates: string;
let customerId: string;
let customerBId: string;
let customerRatesId: string;
let n = 0;

function uniqueName(prefix: string): string {
  n += 1;
  return `${prefix}-${n}`;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Vorlagen Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999996", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const other = await dbInternal.organization.create({ data: { legalName: "Fremde GmbH", addressLine1: "X", postalCode: "1", city: "X" } });
  orgB = other.id;
  await ensureOrgMasterdata(dbInternal, orgB);

  const rates = await dbInternal.organization.create({ data: { legalName: "Satz GmbH", addressLine1: "Y", postalCode: "1", city: "Y" } });
  orgRates = rates.id;
  await ensureOrgMasterdata(dbInternal, orgRates);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;

  const customerB = await dbInternal.customer.create({
    data: { orgId: orgB, name: "Fremdkunde AG", addressLine1: "Z", postalCode: "1", city: "Z", type: "BUSINESS" },
  });
  customerBId = customerB.id;

  const customerRates = await dbInternal.customer.create({
    data: { orgId: orgRates, name: "Satzkunde AG", addressLine1: "W", postalCode: "1", city: "W", type: "BUSINESS" },
  });
  customerRatesId = customerRates.id;
});

function invoiceInput(extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return createInvoiceSchema.parse({
    customerId,
    lines: [{ description: uniqueName("Position"), quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 }],
    ...extra,
  } as CreateInvoiceInput);
}

async function draftInvoice(extra: Partial<CreateInvoiceInput> = {}) {
  return createDraftInvoice(orgId, invoiceInput(extra), { now: FIX_DATE });
}

async function draftQuote(extra: Partial<CreateDocumentInput> = {}) {
  return createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [{ lineType: "ITEM", description: uniqueName("Beratung"), quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
      ...extra,
    } as CreateDocumentInput,
    { now: FIX_DATE },
  );
}

async function draftDeliveryNote() {
  return createDeliveryNote(
    orgId,
    { customerId, headerText: "Kopf", footerText: "Fuss", notes: "Hinweis", lines: [{ description: uniqueName("Ware"), quantityMilli: 5000, unit: "MTR", unitNetPriceCents: 250, taxRate: 19 }] },
    { now: FIX_DATE },
  );
}

describe("saveTemplateFromDocument (INVOICE)", () => {
  it("speichert den GESPEICHERTEN Beleg ohne Nummer, Daten, Snapshots und ohne internalNotes", async () => {
    const inv = await draftInvoice({ internalNotes: "NIE IN DIE VORLAGE", subject: "Wartung" });
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Wartungsvertrag") });

    expect(tpl.payloadJson).not.toContain("NIE IN DIE VORLAGE");
    const p = documentTemplatePayloadSchema.parse(JSON.parse(tpl.payloadJson));
    expect(p.subject).toBe("Wartung");
    expect(p.lines).toHaveLength(inv.lines.length);
    expect(Object.keys(p)).not.toContain("number");
    expect(Object.keys(p)).not.toContain("internalNotes");
    expect(Object.keys(p)).not.toContain("issueDate");
    expect(Object.keys(p)).not.toContain("sellerSnapshotJson");

    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: inv.id, type: "TEMPLATE_SAVED" } })).toBe(1);
  });

  it("interne Notizen landen nicht in der Vorlage", async () => {
    const inv = await draftInvoice({ internalNotes: "Geheime interne Randnotiz" });
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Geheim") });

    const p = documentTemplatePayloadSchema.parse(JSON.parse(tpl.payloadJson));
    expect(p).not.toHaveProperty("internalNotes");
    expect(tpl.payloadJson).not.toContain("Geheime interne Randnotiz");
  });

  it("erzeugt daraus einen Entwurf mit denselben Positionen und Summen", async () => {
    const inv = await draftInvoice({ subject: "Wartung erneut" });
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Wartungsvertrag-B") });

    const res = await applyTemplate(orgId, tpl.id, { customerId });
    expect(res.docType).toBe("INVOICE");

    const neu = await dbInternal.invoice.findUniqueOrThrow({ where: { id: res.id }, include: { lines: true } });
    expect(neu).toMatchObject({ status: "DRAFT", number: null, internalNotes: null, grossTotalCents: inv.grossTotalCents });
    expect(neu.lines).toHaveLength(inv.lines.length);
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: neu.id, type: "TEMPLATE_APPLIED" } })).toBe(1);
  });

  it("zaehlt die Nutzung fort (usageCount/lastUsedAt) und weist unbekannte Payload-Felder beim Parsen ab", async () => {
    const inv = await draftInvoice();
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Zaehler") });
    expect(tpl.usageCount).toBe(0);
    expect(tpl.lastUsedAt).toBeNull();

    await applyTemplate(orgId, tpl.id, { customerId });
    await applyTemplate(orgId, tpl.id, { customerId });

    const after = await dbInternal.documentTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    expect(after.usageCount).toBe(2);
    expect(after.lastUsedAt).not.toBeNull();

    const p = documentTemplatePayloadSchema.parse(JSON.parse(tpl.payloadJson));
    expect(documentTemplatePayloadSchema.safeParse({ ...p, internalNotes: "x" }).success).toBe(false);
  });

  it("wirft TemplateNameConflictError bei doppeltem Namen in derselben Organisation, ok in einer anderen", async () => {
    const invA = await draftInvoice();
    const invB = await draftInvoice();
    const name = uniqueName("Eindeutig");
    await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: invA.id, name });
    await expect(saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: invB.id, name })).rejects.toBeInstanceOf(TemplateNameConflictError);

    const invOrgB = await createDraftInvoice(
      orgB,
      createInvoiceSchema.parse({ customerId: customerBId, lines: [{ description: "Fremd", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19 }] } as CreateInvoiceInput),
      { now: FIX_DATE },
    );
    await expect(saveTemplateFromDocument(orgB, { docType: "INVOICE", docId: invOrgB.id, name })).resolves.toBeDefined();
  });

  it("wirft NotFoundError fuer eine unbekannte Vorlage oder einen unbekannten Quellbeleg", async () => {
    await expect(applyTemplate(orgId, "unbekannt", { customerId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: "unbekannt", name: uniqueName("X") })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("wirft TemplateCustomerRequiredError, wenn weder Anfrage noch Vorlage noch Payload einen Kunden nennen", async () => {
    const payload = documentTemplatePayloadSchema.parse({
      lines: [{ description: "Ohne Kunde", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 }],
    });
    const tpl = await dbInternal.documentTemplate.create({
      data: { orgId, name: uniqueName("Kundenlos"), docType: "INVOICE", customerId: null, payloadJson: JSON.stringify(payload) },
    });
    await expect(applyTemplate(orgId, tpl.id, {})).rejects.toBeInstanceOf(TemplateCustomerRequiredError);

    const res = await applyTemplate(orgId, tpl.id, { customerId });
    expect(res.docType).toBe("INVOICE");
  });
});

describe("renameTemplate (Task 4, /vorlagen)", () => {
  it("aendert nur den Namen, Payload/Kunde/docType bleiben unveraendert", async () => {
    const inv = await draftInvoice({ subject: "Wartung erneut" });
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Alt") });

    const renamed = await renameTemplate(orgId, tpl.id, uniqueName("Neu"));

    expect(renamed.id).toBe(tpl.id);
    expect(renamed.name).not.toBe(tpl.name);
    expect(renamed.payloadJson).toBe(tpl.payloadJson);
    expect(renamed.customerId).toBe(tpl.customerId);
  });

  it("wirft TemplateNameConflictError bei doppeltem Namen, NotFoundError bei unbekannter/fremder id", async () => {
    const inv = await draftInvoice();
    const tplA = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Rename-A") });
    const invB = await draftInvoice();
    const tplB = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: invB.id, name: uniqueName("Rename-B") });

    await expect(renameTemplate(orgId, tplB.id, tplA.name)).rejects.toBeInstanceOf(TemplateNameConflictError);
    await expect(renameTemplate(orgId, "unbekannt", uniqueName("X"))).rejects.toBeInstanceOf(NotFoundError);

    const invOrgB = await createDraftInvoice(
      orgB,
      createInvoiceSchema.parse({ customerId: customerBId, lines: [{ description: "Fremd 4", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19 }] } as CreateInvoiceInput),
      { now: FIX_DATE },
    );
    const tplForeign = await saveTemplateFromDocument(orgB, { docType: "INVOICE", docId: invOrgB.id, name: uniqueName("FremdVorlage-Rename") });
    await expect(renameTemplate(orgId, tplForeign.id, uniqueName("X"))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteTemplate (Task 4, Koordinator-Nachtrag)", () => {
  it("loescht die Vorlage und schreibt TEMPLATE_DELETED ins ActivityLog", async () => {
    const inv = await draftInvoice();
    const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: uniqueName("Zu-loeschen") });

    await deleteTemplate(orgId, tpl.id);

    expect(await dbInternal.documentTemplate.findUnique({ where: { id: tpl.id } })).toBeNull();
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: tpl.id, type: "TEMPLATE_DELETED" } })).toBe(1);
    // Bereits erzeugte Belege bleiben unberuehrt — Loeschen der Vorlage ruehrt keinen Beleg an.
    expect(await dbInternal.invoice.findUnique({ where: { id: inv.id } })).not.toBeNull();
  });

  it("wirft NotFoundError fuer eine unbekannte oder fremde Vorlage (Org-Isolation)", async () => {
    await expect(deleteTemplate(orgId, "unbekannt")).rejects.toBeInstanceOf(NotFoundError);

    const invB = await createDraftInvoice(
      orgB,
      createInvoiceSchema.parse({ customerId: customerBId, lines: [{ description: "Fremd 3", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19 }] } as CreateInvoiceInput),
      { now: FIX_DATE },
    );
    const tplB = await saveTemplateFromDocument(orgB, { docType: "INVOICE", docId: invB.id, name: uniqueName("FremdVorlage-Delete") });
    await expect(deleteTemplate(orgId, tplB.id)).rejects.toBeInstanceOf(NotFoundError);
    // Aus Sicht der Eigentuemer-Org weiterhin vorhanden.
    expect(await dbInternal.documentTemplate.findUnique({ where: { id: tplB.id } })).not.toBeNull();
  });
});

describe("Steuersatz-Pruefung beim Anwenden (kein Bypass)", () => {
  it("ein in der Vorlage gespeicherter, inzwischen gesperrter Steuersatz wird NICHT still uebernommen", async () => {
    const inv7 = await createDraftInvoice(
      orgRates,
      createInvoiceSchema.parse({
        customerId: customerRatesId,
        lines: [{ description: "Ermaessigt", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 7 }],
      } as CreateInvoiceInput),
      { now: FIX_DATE },
    );
    const tpl7 = await saveTemplateFromDocument(orgRates, { docType: "INVOICE", docId: inv7.id, name: uniqueName("Ermaessigt") });

    await saveDocumentSettings(orgRates, { ...(await loadDocumentSettings(orgRates)), taxRates: [19, 0] }); // 7 % gesperrt

    await expect(applyTemplate(orgRates, tpl7.id, { customerId: customerRatesId })).rejects.toThrow(/Steuersatz/i);
    await expect(applyTemplate(orgRates, tpl7.id, { customerId: customerRatesId })).rejects.toBeInstanceOf(TaxRateNotAllowedError);
  });
});

describe("QUOTE-Vorlagen", () => {
  it("speichert kind und wendet daraus dieselbe Angebotsart an", async () => {
    const quote = await draftQuote({ kind: "AUFTRAGSBESTAETIGUNG", subject: "Montage" });
    const tpl = await saveTemplateFromDocument(orgId, { docType: "QUOTE", docId: quote.id, name: uniqueName("AB-Vorlage") });
    expect(tpl.kind).toBe("AUFTRAGSBESTAETIGUNG");

    const res = await applyTemplate(orgId, tpl.id, { customerId });
    expect(res.docType).toBe("QUOTE");
    const neu = await dbInternal.quote.findUniqueOrThrow({ where: { id: res.id } });
    expect(neu.kind).toBe("AUFTRAGSBESTAETIGUNG");
    expect(neu.subject).toBe("Montage");
    // Geschaeftsdokument bekommt SOFORT eine Nummer (kein GoBD-Beleg, anders als INVOICE).
    expect(neu.number).not.toBeNull();
  });
});

describe("DELIVERY_NOTE-Vorlagen", () => {
  it("bildet Lieferschein-Zeilen auf ITEM-Positionen ab (Modell kennt kein lineType/taxCategory/discount)", async () => {
    const note = await draftDeliveryNote();
    const tpl = await saveTemplateFromDocument(orgId, { docType: "DELIVERY_NOTE", docId: note.id, name: uniqueName("Lieferschein-Vorlage") });

    const res = await applyTemplate(orgId, tpl.id, { customerId });
    expect(res.docType).toBe("DELIVERY_NOTE");

    const neu = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: res.id }, include: { lines: true } });
    expect(neu.headerText).toBe("Kopf");
    expect(neu.number).not.toBeNull();
    expect(neu.lines).toHaveLength(1);
    expect(neu.lines[0]).toMatchObject({ unit: "MTR", unitNetPriceCents: 250, taxRate: 19 });
  });
});

describe("Org-Isolation", () => {
  it("eine Vorlage einer fremden Organisation ist unsichtbar (applyTemplate/listTemplates)", async () => {
    const invB = await createDraftInvoice(
      orgB,
      createInvoiceSchema.parse({ customerId: customerBId, lines: [{ description: "Fremd 2", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19 }] } as CreateInvoiceInput),
      { now: FIX_DATE },
    );
    const tplB = await saveTemplateFromDocument(orgB, { docType: "INVOICE", docId: invB.id, name: uniqueName("FremdVorlage") });

    await expect(applyTemplate(orgId, tplB.id, { customerId })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listTemplates(orgId)).some((t) => t.id === tplB.id)).toBe(false);
  });
});

describe("listTemplates", () => {
  it("filtert nach docType und liefert eine nach Namen sortierte Liste", async () => {
    const invLocal = await draftInvoice();
    await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: invLocal.id, name: uniqueName("Liste-INVOICE") });
    const note = await draftDeliveryNote();
    const dnTpl = await saveTemplateFromDocument(orgId, { docType: "DELIVERY_NOTE", docId: note.id, name: uniqueName("Liste-DN") });

    const onlyInvoices = await listTemplates(orgId, "INVOICE");
    expect(onlyInvoices.every((t) => t.docType === "INVOICE")).toBe(true);
    expect(onlyInvoices.some((t) => t.id === dnTpl.id)).toBe(false);

    const onlyNotes = await listTemplates(orgId, "DELIVERY_NOTE");
    expect(onlyNotes.some((t) => t.id === dnTpl.id)).toBe(true);

    const all = await listTemplates(orgId);
    const names = all.map((t) => t.name);
    expect(names.every((v, i) => i === 0 || names[i - 1] <= v)).toBe(true);
  });
});
