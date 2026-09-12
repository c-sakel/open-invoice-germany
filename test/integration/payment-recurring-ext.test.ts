/**
 * Phase 8b, Task 1: Zahlungsnotiz, wiederkehrende Rechnungen — DAY-Intervall,
 * maxRuns, emailTemplateId beim autoSend.
 *
 * Eigenes Jahr (2064, Plan-Header) fuer die Nummernvergabe — "Invoice.number" ist
 * global @unique und test.db wird ueber die gesamte Testlaufzeit geteilt (siehe
 * Kommentar in payment-skonto.test.ts).
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveMailSettings } from "@/domain/email/settings";
import { saveEmailTemplate } from "@/domain/email/templates";
import { createMemoryProvider } from "@/lib/mail/memory";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringNow, runDueRecurring } from "@/domain/recurring/run";
import { recordPaymentSchema, type CreateInvoiceInput } from "@/schemas";
// Phase 14a, Task 1 (R1-R5) — Kundenvorgaben-Uebernahme, Steuersatz-Vererbung,
// ChangeLog-Kette, Kopftext/BG-14.
import { saveDocumentSettings, loadDocumentSettings } from "@/domain/document/settings";
import { createAddress } from "@/domain/customer/addresses";
import { createContact } from "@/domain/customer/contacts";
import { saveTextTemplate } from "@/domain/text-template/manage";
import { computeLineNet } from "@/lib/pricing/line";
import { computeTaxBreakdown } from "@/lib/tax";
import { verifyChain, type ChainEntry } from "@/domain/changelog";

let orgId: string;
let customerId: string;
let n = 0;
const FIX_DATE = new Date("2064-06-09T10:00:00.000Z");

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Zahlung/Abo Test GmbH",
      addressLine1: "Hauptstr. 1",
      postalCode: "21339",
      city: "Lüneburg",
      vatId: "DE123456789",
      taxNumber: "33/123/45678",
    },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveMailSettings(orgId, {
    host: "localhost",
    port: 2525,
    security: "NONE",
    fromName: "Zahlung/Abo Test GmbH",
    fromEmail: "rechnung@example.org",
    defaultCc: "",
    defaultBcc: "",
    copyToSelf: false,
  });
});

function makeCustomer(email: string) {
  n += 1;
  return dbInternal.customer.create({
    data: { orgId, name: `Abo-Kunde ${n} AG`, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email },
  });
}

async function finalizedInvoice(): Promise<{ id: string; grossTotalCents: number }> {
  const input: CreateInvoiceInput = {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    issueDate: FIX_DATE,
    lines: [
      { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 100000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 },
    ],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input, { now: FIX_DATE });
  const fin = await finalizeInvoice(draft.id, { now: FIX_DATE });
  return { id: fin.id, grossTotalCents: fin.grossTotalCents };
}

const line = { lineType: "ITEM" as const, description: "Wartung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 5000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0, discountCents: 0 };

describe("recordPayment: Notiz", () => {
  it("note wird persistiert", async () => {
    const inv = await finalizedInvoice();
    const result = await recordPayment(
      inv.id,
      recordPaymentSchema.parse({ amountCents: 1000, method: "TRANSFER", note: "Per Scheck, Kunde meldete sich telefonisch" }),
    );
    const stored = await dbInternal.payment.findFirst({ where: { invoiceId: inv.id } });
    expect(stored?.note).toBe("Per Scheck, Kunde meldete sich telefonisch");
    expect(result.payment.paidAmountCents).toBe(1000);
  });

  it("note ist optional (bleibt NULL ohne Angabe)", async () => {
    const inv = await finalizedInvoice();
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: 500, method: "TRANSFER" }));
    const stored = await dbInternal.payment.findFirst({ where: { invoiceId: inv.id } });
    expect(stored?.note).toBeNull();
  });
});

describe("Recurring: DAY-Intervall", () => {
  it("DAY x 10: naechster Lauf +10 Tage", async () => {
    const customer = await makeCustomer("day-interval@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Taegliches Abo",
      interval: "DAY",
      intervalCount: 10,
      startDate: new Date("2064-07-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [line],
    });
    expect(rec.nextRunDate.toISOString().slice(0, 10)).toBe("2064-07-01");

    const emitted = await emitRecurringNow(rec.id, { now: new Date("2064-07-01T10:00:00.000Z") });
    expect(emitted.invoiceId).toBeTruthy();

    const updated = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id } });
    expect(updated.nextRunDate.toISOString().slice(0, 10)).toBe("2064-07-11"); // +10 Tage
    expect(updated.issuedCount).toBe(1);
  });
});

describe("Recurring: maxRuns", () => {
  it("maxRuns 2: nach dem zweiten Lauf ENDED, kein dritter Lauf", async () => {
    const customer = await makeCustomer("max-runs@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo mit Laufbegrenzung",
      interval: "MONTHLY",
      intervalCount: 1,
      maxRuns: 2,
      startDate: new Date("2064-08-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [line],
    });

    const summaries = await runDueRecurring({ now: new Date("2065-01-01T10:00:00.000Z"), orgId, maxPerAbo: 10 });
    const summary = summaries.find((s) => s.recurringId === rec.id)!;
    // Faellig bis 2065-01-01 waeren eigentlich mehr als 2 Monatslaeufe (Aug-Dez) —
    // maxRuns=2 bricht den Batch-Lauf nach dem zweiten Lauf ab (ended=true -> break).
    expect(summary.emitted).toHaveLength(2);

    const updated = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id } });
    expect(updated.status).toBe("ENDED");
    expect(updated.issuedCount).toBe(2);

    // Ein weiterer manueller Lauf darf jetzt nicht mehr moeglich sein (Abo ist ENDED).
    await expect(emitRecurringNow(rec.id, { now: new Date("2065-02-01T10:00:00.000Z") })).rejects.toThrow();
  });
});

// Fix-Welle Phase 8b (Nit): Reaktivierung eines wegen maxRuns beendeten Abos ohne
// gleichzeitige maxRuns-Erhoehung wuerde beim naechsten Lauf sofort wieder auf ENDED
// zurueckfallen (stiller Zyklus) — updateRecurringInvoke lehnt das jetzt mit einer
// klaren Fehlermeldung ab (409 auf Routen-Ebene). logActivity UPDATED wird ausserdem
// bei jeder erfolgreichen Aenderung geschrieben (vorher keinerlei Timeline-Eintrag fuer
// Abo-Bearbeitungen).
describe("Recurring: Reaktivierung aus ENDED (maxRuns) + logActivity UPDATED", () => {
  it("ACTIVE aus ENDED mit issuedCount >= maxRuns wird abgelehnt (InvalidOperationError)", async () => {
    const customer = await makeCustomer("reactivate-blocked@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo Reaktivierung blockiert",
      interval: "MONTHLY",
      intervalCount: 1,
      maxRuns: 2,
      startDate: new Date("2064-08-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [line],
    });
    await runDueRecurring({ now: new Date("2065-01-01T10:00:00.000Z"), orgId, maxPerAbo: 10 });
    const ended = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id } });
    expect(ended.status).toBe("ENDED");

    const { updateRecurringInvoice } = await import("@/domain/recurring/update");
    await expect(updateRecurringInvoice(orgId, rec.id, { status: "ACTIVE" })).rejects.toThrow(/reaktiviert/);

    // Mit gleichzeitiger maxRuns-Erhoehung ist die Reaktivierung erlaubt.
    const reactivated = await updateRecurringInvoice(orgId, rec.id, { status: "ACTIVE", maxRuns: 5 });
    expect(reactivated.status).toBe("ACTIVE");
  });

  it("updateRecurringInvoice schreibt einen ActivityLog-Eintrag UPDATED fuer RECURRING", async () => {
    const customer = await makeCustomer("recurring-activity@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo Activity-Test",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2064-08-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [line],
    });
    const { updateRecurringInvoice } = await import("@/domain/recurring/update");
    await updateRecurringInvoice(orgId, rec.id, { title: "Abo Activity-Test (geaendert)" }, "tester");

    const activity = await dbInternal.activityLog.findFirst({ where: { orgId, entityType: "RECURRING", entityId: rec.id, type: "UPDATED" } });
    expect(activity).not.toBeNull();
    expect(activity?.actor).toBe("tester");
  });
});

describe("Recurring: autoSend nutzt emailTemplateId", () => {
  it("verwendet die auf dem Abo hinterlegte Vorlage statt der Standardvorlage", async () => {
    const customer = await makeCustomer("autosend-template@example.org");
    const template = await saveEmailTemplate(orgId, {
      name: "Abo-Sondervorlage",
      docType: "INVOICE",
      subject: "Ihre Sonderrechnung (Sondervorlage)",
      body: "Sehr geehrte Damen und Herren, anbei die Sonderrechnung.",
      isDefault: false,
    });

    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo mit eigener Vorlage",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2064-09-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: true,
      autoSend: true,
      emailTemplateId: template.id,
      lines: [line],
    });

    const provider = createMemoryProvider();
    const now = rec.nextRunDate; // zeitzonenfest (12:00 Ortszeit, s. scheduler.test.ts)
    const summaries = await runDueRecurring({ now, orgId, provider });
    const summary = summaries.find((s) => s.recurringId === rec.id)!;
    expect(summary.emitted).toHaveLength(1);
    expect(summary.emitted[0]!.emailStatus).toBe("SENT");

    const log = await dbInternal.emailLog.findFirst({ where: { orgId, docId: summary.emitted[0]!.invoiceId, status: "SENT" } });
    expect(log).not.toBeNull();
    expect(log?.templateId).toBe(template.id);
    expect(log?.subject).toContain("Ihre Sonderrechnung");
  });
});

// Phase 14a, Task 1 (R1-R5, §28-§30): Abo-Rechnungen laufen ab jetzt ueber
// createDraftInvoiceWithinTx — Kundenvorgaben werden uebernommen, die Abo-eigenen Felder
// (Zahlungsfrist, Steuersatz) bleiben trotzdem vorrangig.
describe("Recurring: Kundenvorgaben werden uebernommen (R1/R2)", () => {
  it("Zahlungsart, Adressen, Ansprechpartner, Rabatt und Bestellreferenz des Kunden landen auf der erzeugten Rechnung; der Betrag sinkt um den Rabatt", async () => {
    const customer = await makeCustomer("kundenvorgaben-abo@example.org");
    const method = await dbInternal.paymentMethod.create({ data: { orgId, code: "ABO_VORGABE", name: "Abo-Vorgabe-Zahlungsart", untdidCode: "58" } });
    const billing = await createAddress(orgId, customer.id, { type: "BILLING", addressLine1: "Rechnungsweg 5", postalCode: "10115", city: "Berlin", isDefault: true });
    const shipping = await createAddress(orgId, customer.id, { type: "SHIPPING", addressLine1: "Lagerweg 5", postalCode: "20095", city: "Hamburg", isDefault: true });
    const contact = await createContact(orgId, customer.id, { firstName: "Vera", lastName: "Vorgabe", isDefault: true });
    // Exakter Wert aus dem Plan (Task 1, Tests): defaultDiscountPermille = 50 (= 5 %).
    await dbInternal.customer.update({
      where: { id: customer.id },
      data: { defaultPaymentMethodId: method.id, defaultDiscountPermille: 50, orderReference: "PO-4711" },
    });

    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo mit Kundenvorgaben",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2064-10-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [line],
    });

    const emitted = await emitRecurringNow(rec.id, { now: new Date("2064-10-01T10:00:00.000Z") });
    const invoice = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId } });

    expect(invoice.paymentMethodId).toBe(method.id);
    expect(invoice.billingAddressId).toBe(billing.id);
    expect(invoice.shippingAddressId).toBe(shipping.id);
    expect(invoice.contactPersonId).toBe(contact.id);
    expect(invoice.orderNumber).toBe("PO-4711");
    expect(invoice.documentDiscountPermille).toBe(50);

    // grossTotalCents ist um den Kundenrabatt niedriger als ohne Rabatt (dieselbe
    // Berechnung wie createDraftInvoiceWithinTx, R2).
    const lineNetCents = computeLineNet({
      quantityMilli: line.quantityMilli,
      unitNetPriceCents: line.unitNetPriceCents,
      discountPermille: line.discountPermille,
    }).lineNetCents;
    const withoutDiscount = computeTaxBreakdown([{ lineNetCents, taxRate: line.taxRate, taxCategory: line.taxCategory }]);
    const withDiscount = computeTaxBreakdown([{ lineNetCents, taxRate: line.taxRate, taxCategory: line.taxCategory }], { discountPermille: 50 });
    expect(invoice.grossTotalCents).toBe(withDiscount.grossTotalCents);
    expect(withDiscount.grossTotalCents).toBeLessThan(withoutDiscount.grossTotalCents);
  });
});

describe("Recurring: Abo-Zahlungsziel schlaegt die Kundenvorgabe (R1)", () => {
  it("dueDate = issueDate + Abo-paymentTermsDays, Customer.defaultPaymentTermsDays bleibt wirkungslos", async () => {
    const customer = await makeCustomer("zahlungsziel-vorrang@example.org");
    await dbInternal.customer.update({ where: { id: customer.id }, data: { defaultPaymentTermsDays: 7 } });

    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo mit eigenem Zahlungsziel",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2064-10-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 30,
      autoFinalize: false,
      lines: [line],
    });

    const now = new Date("2064-10-01T10:00:00.000Z");
    const emitted = await emitRecurringNow(rec.id, { now });
    const invoice = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId } });
    const expectedDue = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(invoice.dueDate).not.toBeNull();
    expect(invoice.dueDate!.toISOString().slice(0, 10)).toBe(expectedDue.toISOString().slice(0, 10));
  });
});

describe("Recurring: geerbter Steuersatz bleibt gueltig, auch nach Delisting (R3)", () => {
  it("Abo mit 16 % laeuft weiter, obwohl die Org-Liste zum Lauf-Zeitpunkt nur noch 19/7/0 fuehrt", async () => {
    const customer = await makeCustomer("steuersatz-16-abo@example.org");
    const before = await loadDocumentSettings(orgId);
    await saveDocumentSettings(orgId, { ...before, taxRates: [...before.taxRates, 16] });

    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo mit 16 %",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2064-11-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [{ ...line, taxRate: 16 }],
    });

    // Delisting NACH Abo-Anlage, VOR dem Lauf — die Org-Liste fuehrt 16 % nicht mehr.
    await saveDocumentSettings(orgId, before);

    const emitted = await emitRecurringNow(rec.id, { now: new Date("2064-11-01T10:00:00.000Z") });
    const invoice = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId }, include: { lines: true } });
    expect(invoice.lines[0]!.taxRate).toBe(16);
  });
});

describe("Recurring: genau ein ChangeLog-CREATE-Eintrag je Rechnung, Kette bleibt gueltig", () => {
  it("kein zweiter Eintrag durch den Abo-Lauf, Abo-Kontext steht im Diff des gemeinsamen Pfads", async () => {
    const customer = await makeCustomer("changelog-abo@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo ChangeLog-Test",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2064-12-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      lines: [line],
    });
    const emitted = await emitRecurringNow(rec.id, { now: new Date("2064-12-01T10:00:00.000Z") });

    const createEntries = await dbInternal.changeLog.findMany({
      where: { orgId, entity: "INVOICE", entityId: emitted.invoiceId, action: "CREATE" },
    });
    expect(createEntries).toHaveLength(1);
    expect(JSON.parse(createEntries[0]!.diffJson)).toMatchObject({ recurring: rec.id });

    const rows = await dbInternal.changeLog.findMany({
      where: { orgId },
      orderBy: { id: "asc" },
      select: { prevHash: true, hash: true, entity: true, entityId: true, action: true, actor: true, at: true, diffJson: true },
    });
    const entries: ChainEntry[] = rows.map((r) => ({
      prevHash: r.prevHash,
      hash: r.hash,
      payload: { entity: r.entity, entityId: r.entityId, action: r.action, actor: r.actor, at: r.at.toISOString(), diff: JSON.parse(r.diffJson) },
    }));
    expect(verifyChain(entries).valid).toBe(true);
  });
});

describe("Recurring: Kopftext folgt showPeriodText (R4/R5)", () => {
  it("showPeriodText aus: die INVOICE-HEAD-Textvorlage greift, kein Zeitraumtext, kein BG-14", async () => {
    await saveTextTemplate(orgId, {
      name: "Standard-Kopftext (Phase 14a Test)",
      docType: "INVOICE",
      position: "HEAD",
      body: "Vielen Dank fuer Ihren Auftrag.",
      isDefault: true,
    });
    const customer = await makeCustomer("kopftext-aus@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo ohne Zeitraumtext",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2065-01-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      showPeriodText: false,
      lines: [line],
    });

    const emitted = await emitRecurringNow(rec.id, { now: new Date("2065-01-01T10:00:00.000Z") });
    const invoice = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId } });
    expect(invoice.headerText).toBe("Vielen Dank fuer Ihren Auftrag.");
    expect(invoice.deliveryStart).toBeNull();
    expect(invoice.deliveryEnd).toBeNull();
  });

  it("showPeriodText an: Zeitraumtext im Kopf, BG-14 (deliveryStart/deliveryEnd = Periodengrenzen) gesetzt", async () => {
    const customer = await makeCustomer("kopftext-an@example.org");
    const rec = await createRecurring(orgId, {
      customerId: customer.id,
      title: "Abo mit Zeitraumtext",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: new Date("2065-01-01T10:00:00.000Z"),
      taxScheme: "REGULAR",
      currency: "EUR",
      paymentTermsDays: 14,
      autoFinalize: false,
      showPeriodText: true,
      lines: [line],
    });

    const emitted = await emitRecurringNow(rec.id, { now: new Date("2065-01-01T10:00:00.000Z") });
    const invoice = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId } });
    expect(invoice.headerText).toMatch(/^Abrechnungszeitraum /);
    expect(invoice.deliveryStart).not.toBeNull();
    expect(invoice.deliveryEnd?.toISOString().slice(0, 10)).toBe("2065-01-01");
    expect(invoice.deliveryStart?.toISOString().slice(0, 10)).toBe("2064-12-01");
  });
});
