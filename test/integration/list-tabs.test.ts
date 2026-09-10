/**
 * Phase 13a, Task 3 — Status-Tabs und Tab-Zaehler (invoiceStatusTabCounts,
 * quoteStatusTabCounts, deliveryNoteStatusTabCounts, recurringStatusTabCounts).
 *
 * Ruling (task-3-brief.md, Abweichung von der Spec, begruendet): Die Spec fordert als Test
 * "Summe aller Tabs ausser 'Alle' ergibt 'Alle'". Das ist mit der bestehenden Statussemantik
 * falsch: `statusWhere` (invoice/list.ts, Fix-Welle S1) zaehlt eine teilbezahlte Rechnung mit
 * Restbetrag sowohl unter "partial" (Rohstatus PARTIALLY_PAID) als auch unter "open"/"due"/
 * "overdue". Ein disjunkter Neu-Statusbegriff waere genau die verbotene Doppelung. Geprueft
 * wird deshalb (a) `draft + open + due + overdue + paid + cancelled === all` (diese sechs
 * SIND disjunkt und vollstaendig) und (b) fuer JEDEN Tab `count === listInvoices({status:
 * tab}).total` — die staerkere Aussage, die jede Abweichung zwischen Zaehler und Liste
 * ausschliesst.
 *
 * Eigenes Jahr: 2088 statt der im Brief genannten 2064 — 2064 ist bereits durch
 * test/integration/payment-recurring-ext.test.ts belegt (finalisiert dort ebenfalls echte
 * Rechnungen ueber assignDocumentNumber). Da "Invoice.number" instanzweit @unique ist und
 * test.db ueber die gesamte Testlaufzeit geteilt wird (beide Organisationen wuerden beim
 * jeweils ersten Beleg des Jahres dieselbe formatierte Nummer ziehen — der Nummernkreis ist
 * je Org/Jahr gezaehlt, das Format traegt aber keine Org-Kennung), waere 2064 hier ein
 * echtes Kollisionsrisiko. 2088 ist laut Testjahr-Konvention (grep "Eigenes Jahr" ueber
 * test/) noch unbenutzt.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { listInvoices, invoiceStatusTabCounts } from "@/domain/invoice/list";
import { createBusinessDocument } from "@/domain/document/create";
import { setQuoteStatus, setArchived, setDeliveryNoteStatus } from "@/domain/document/status";
import {
  listQuotes,
  quoteStatusTabCounts,
  listDeliveryNotes,
  deliveryNoteStatusTabCounts,
  deliveryNoteListHeadline,
  listRecurring,
  recurringStatusTabCounts,
} from "@/domain/document/list";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createRecurring } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import {
  recordPaymentSchema,
  InvoiceListStatusFilter,
  DeliveryNoteStatus,
  type CreateInvoiceInput,
  type CreateDocumentInput,
  type CreateDeliveryNoteInput,
  type CreateRecurringInput,
} from "@/schemas";

let orgId: string;
let customerId: string;
let otherOrgId: string;

const NOW = new Date(Date.UTC(2088, 5, 15, 10, 0, 0));
const TODAY = new Date(Date.UTC(2088, 5, 15));
const YESTERDAY = new Date(Date.UTC(2088, 5, 14));
const IN_10_DAYS = new Date(Date.UTC(2088, 5, 25));

function line(description: string) {
  return {
    description,
    quantityMilli: 1000,
    unit: "HUR" as const,
    unitNetPriceCents: 10000,
    taxRate: 19 as const,
    taxCategory: "S" as const,
    discountPermille: 0,
  };
}

async function draftInvoice(description: string) {
  const input: CreateInvoiceInput = {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    issueDate: NOW,
    lines: [line(description)],
  } as CreateInvoiceInput;
  return createDraftInvoice(orgId, input, { now: NOW });
}

async function finalizedInvoice(description: string, dueDate: Date) {
  const draft = await draftInvoice(description);
  await dbInternal.invoice.update({ where: { id: draft.id }, data: { dueDate } });
  return finalizeInvoice(draft.id, { now: NOW });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Tabzaehler Test GmbH",
      addressLine1: "Zaehlerweg 1",
      postalCode: "24941",
      city: "Flensburg",
      vatId: "DE111222333",
      taxNumber: "21/555/44443",
    },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Tab-Kunde AG", addressLine1: "Ringstr. 4", postalCode: "24939", city: "Flensburg", type: "BUSINESS" },
  });
  customerId = customer.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  // Rechnungen: Entwurf, offen, faellig heute, ueberfaellig, teilbezahlt+ueberfaellig,
  // bezahlt, storniert.
  await draftInvoice("Zaehlertest Sonderposten");
  await finalizedInvoice("Wartungsvertrag", IN_10_DAYS);
  await finalizedInvoice("Beratung Standardvertrag", TODAY);
  await finalizedInvoice("Beratung Standardvertrag", YESTERDAY);

  const partial = await finalizedInvoice("Beratung Standardvertrag", YESTERDAY);
  await recordPayment(partial.id, recordPaymentSchema.parse({ amountCents: 1000, method: "TRANSFER", paidAt: NOW }));

  const paid = await finalizedInvoice("Beratung Standardvertrag", YESTERDAY);
  await recordPayment(paid.id, recordPaymentSchema.parse({ amountCents: 11900, method: "TRANSFER", paidAt: NOW }));

  const cancelled = await finalizedInvoice("Beratung Standardvertrag", YESTERDAY);
  await cancelInvoice(cancelled.id, { now: NOW });

  // Angebote: zwei abgelaufene (DRAFT + SENT, validUntil in der Vergangenheit => EXPIRED),
  // ein aktives DRAFT (validUntil in der Zukunft), ein angenommenes, ein archiviertes.
  await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    validUntil: YESTERDAY,
    lines: [line("Zaehlertest abgelaufenes Angebot (DRAFT)")],
  } as CreateDocumentInput);

  const expiredSentQuote = await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    validUntil: YESTERDAY,
    lines: [line("Zaehlertest abgelaufenes Angebot (SENT)")],
  } as CreateDocumentInput);
  await setQuoteStatus(orgId, expiredSentQuote.id, "SENT", { now: NOW });

  await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    validUntil: IN_10_DAYS,
    lines: [line("Zaehlertest aktives Angebot")],
  } as CreateDocumentInput);

  const acceptedQuote = await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    lines: [line("Zaehlertest angenommenes Angebot")],
  } as CreateDocumentInput);
  await setQuoteStatus(orgId, acceptedQuote.id, "ACCEPTED", { now: NOW });

  const archivedQuote = await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    lines: [line("Zaehlertest archiviertes Angebot")],
  } as CreateDocumentInput);
  await setArchived(orgId, "QUOTE", archivedQuote.id, true, "tester", NOW);

  // Lieferscheine: createDeliveryNote vergibt direkt Status CREATED (kein DRAFT-Pfad —
  // offener Backlog-Punkt, siehe CLAUDE.md). Fixtures daher CREATED, SENT, DELIVERED.
  await createDeliveryNote(
    orgId,
    { customerId, deliveryDate: NOW, lines: [line("Zaehlertest Lieferschein erstellt")] } as unknown as CreateDeliveryNoteInput,
    { actor: "tester", now: NOW },
  );

  const dnSent = await createDeliveryNote(
    orgId,
    { customerId, deliveryDate: NOW, lines: [line("Zaehlertest Lieferschein versendet")] } as unknown as CreateDeliveryNoteInput,
    { actor: "tester", now: NOW },
  );
  await setDeliveryNoteStatus(orgId, dnSent.id, "SENT", { now: NOW, actor: "tester" });

  const dnDelivered = await createDeliveryNote(
    orgId,
    { customerId, deliveryDate: NOW, lines: [line("Zaehlertest Lieferschein zugestellt")] } as unknown as CreateDeliveryNoteInput,
    { actor: "tester", now: NOW },
  );
  await setDeliveryNoteStatus(orgId, dnDelivered.id, "SENT", { now: NOW, actor: "tester" });
  await setDeliveryNoteStatus(orgId, dnDelivered.id, "DELIVERED", { now: NOW, actor: "tester" });

  // Abos: eines aktiv, eines pausiert.
  await createRecurring(orgId, {
    customerId,
    title: "Zaehlertest Abo aktiv",
    interval: "MONTHLY",
    intervalCount: 1,
    startDate: NOW,
    taxScheme: "REGULAR",
    currency: "EUR",
    paymentTermsDays: 14,
    lines: [line("Zaehlertest Abo Position")],
  } as CreateRecurringInput);

  const pausedRecurring = await createRecurring(orgId, {
    customerId,
    title: "Zaehlertest Abo pausiert",
    interval: "MONTHLY",
    intervalCount: 1,
    startDate: NOW,
    taxScheme: "REGULAR",
    currency: "EUR",
    paymentTermsDays: 14,
    lines: [line("Zaehlertest Abo Position")],
  } as CreateRecurringInput);
  await updateRecurringInvoice(orgId, pausedRecurring.id, { status: "PAUSED" }, "tester");

  // Zweite Organisation: genau EINE Rechnung — zaehlt nicht in orgId mit.
  const otherOrg = await dbInternal.organization.create({
    data: {
      legalName: "Fremdorg Zaehlertest GmbH",
      addressLine1: "Nebenstr. 2",
      postalCode: "24941",
      city: "Flensburg",
      vatId: "DE999888777",
      taxNumber: "21/555/44499",
    },
  });
  otherOrgId = otherOrg.id;
  const otherCustomer = await dbInternal.customer.create({
    data: { orgId: otherOrgId, name: "Fremdkunde AG", addressLine1: "Ringstr. 5", postalCode: "24939", city: "Flensburg", type: "BUSINESS" },
  });
  await ensureOrgMasterdata(dbInternal, otherOrgId);
  const otherInput: CreateInvoiceInput = {
    customerId: otherCustomer.id,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    issueDate: NOW,
    lines: [line("Fremdorg Beleg")],
  } as CreateInvoiceInput;
  await createDraftInvoice(otherOrgId, otherInput, { now: NOW });
});

describe("invoiceStatusTabCounts", () => {
  it("jeder Tab zaehlt genau so viele Zeilen, wie die Liste mit diesem Status liefert", async () => {
    const counts = await invoiceStatusTabCounts(orgId, {}, NOW);
    for (const tab of InvoiceListStatusFilter.options) {
      expect({ tab, n: counts[tab] }).toEqual({ tab, n: (await listInvoices(orgId, { status: tab, limit: 200 }, NOW)).total });
    }
  });

  it("die sechs disjunkten Tabs ergeben zusammen 'Alle'", async () => {
    const c = await invoiceStatusTabCounts(orgId, {}, NOW);
    expect(c.draft + c.open + c.due + c.overdue + c.paid + c.cancelled).toBe(c.all);
  });

  it("ein Textfilter wirkt auf ALLE Zaehler, eine fremde Organisation zaehlt nicht mit", async () => {
    const c = await invoiceStatusTabCounts(orgId, { q: "Zaehlertest" }, NOW);
    expect(c.all).toBe((await listInvoices(orgId, { q: "Zaehlertest", limit: 200 }, NOW)).total);
    expect((await invoiceStatusTabCounts(otherOrgId, {}, NOW)).all).toBe(1);
  });
});

describe("quoteStatusTabCounts", () => {
  it("EXPIRED zaehlt abgelaufene DRAFT/SENT, archiviert wirkt auf alle Zaehler", async () => {
    const counts = await quoteStatusTabCounts(orgId, {}, NOW);
    expect(counts.EXPIRED).toBe(2);
    expect(counts.EXPIRED).toBe((await listQuotes(orgId, { status: "EXPIRED", limit: 200 }, NOW)).total);
    expect(counts.all).toBe((await listQuotes(orgId, { limit: 200 }, NOW)).total);

    // Das archivierte Angebot zaehlt standardmaessig (includeArchived=false) nicht mit,
    // wirkt aber auf ALLE Zaehler gleichermassen, sobald includeArchived gesetzt ist.
    const withArchived = await quoteStatusTabCounts(orgId, { includeArchived: true }, NOW);
    expect(withArchived.all).toBe(counts.all! + 1);
    expect(withArchived.all).toBe((await listQuotes(orgId, { includeArchived: true, limit: 200 }, NOW)).total);
  });
});

describe("deliveryNoteStatusTabCounts", () => {
  it("jeder Tab zaehlt genau so viele Zeilen, wie listDeliveryNotes mit diesem Status liefert", async () => {
    const counts = await deliveryNoteStatusTabCounts(orgId, {});
    for (const tab of ["all", ...DeliveryNoteStatus.options] as const) {
      expect({ tab, n: counts[tab] }).toEqual({ tab, n: (await listDeliveryNotes(orgId, { status: tab, limit: 200 })).total });
    }
    expect(counts.CREATED).toBeGreaterThanOrEqual(1);
    expect(counts.SENT).toBeGreaterThanOrEqual(1);
    expect(counts.DELIVERED).toBeGreaterThanOrEqual(1);
  });
});

describe("deliveryNoteListHeadline (Fix-Welle 1, M4)", () => {
  it("count() entspricht der gefilterten Liste — bewusst KEIN grossCents (DeliveryNote hat keine Bruttosumme)", async () => {
    const headline = await deliveryNoteListHeadline(orgId, {});
    expect(headline).toEqual({ count: (await listDeliveryNotes(orgId, { limit: 200 })).total });
    // Vertragstest: traegt NUR `count`, nie ein `grossCents`/`currency` (Schemaluecke — DeliveryNote hat keine Bruttosumme, siehe Kommentar in list.ts).
    expect(Object.keys(headline)).toEqual(["count"]);

    // Filter wirken auf die Kennzahl genau wie auf die Liste.
    const sentOnly = await deliveryNoteListHeadline(orgId, { status: "SENT" });
    expect(sentOnly.count).toBe((await listDeliveryNotes(orgId, { status: "SENT", limit: 200 })).total);
    expect(sentOnly.count).toBeGreaterThanOrEqual(1);

    // Fremde Organisation (keine eigenen Lieferscheine in dieser Fixtur) zaehlt nicht mit.
    expect((await deliveryNoteListHeadline(otherOrgId, {})).count).toBe(0);
  });
});

describe("recurringStatusTabCounts", () => {
  it("jeder Tab zaehlt genau so viele Zeilen, wie listRecurring mit diesem Status liefert", async () => {
    const counts = await recurringStatusTabCounts(orgId, {});
    for (const tab of ["all", "ACTIVE", "PAUSED", "ENDED"] as const) {
      expect({ tab, n: counts[tab] }).toEqual({ tab, n: (await listRecurring(orgId, { status: tab, limit: 200 })).total });
    }
    expect(counts.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(counts.PAUSED).toBeGreaterThanOrEqual(1);
  });
});
