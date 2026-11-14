/**
 * Phase 18d Task 4: Rechnung atomar anlegen, festschreiben und Zahlung erfassen. Testjahr 2192
 * (Invoice.number ist global eindeutig), Praefix D18D4-. Der Transaktions-Guard (tx-guard-setup)
 * ist in allen Tests aktiv: ein Zugriff ueber den globalen Client in der Transaktion schlaegt fehl.
 */
import { describe, it, expect, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice, FinalizeError } from "@/domain/invoice/finalize";
import { recordPayment, PaymentError } from "@/domain/invoice/payment";
import { createInvoiceComplete } from "@/domain/invoice/create-complete";
import { collectFinalizeWarnings, collectFinalizeWarningsFor } from "@/domain/invoice/finalize-warnings";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { NotFoundError } from "@/domain/errors";
import { createInvoiceSchema, type CreateInvoiceInput } from "@/schemas";

const NOW = new Date("2192-03-10T10:00:00.000Z");
// Belegnummern sind instanzweit eindeutig: Praefix je Org (D18D4- + Org-Kennung), sonst Kollision zwischen Orgs/Laeufen.
const PREFIX = "D18D4-";

async function makeOrg(name: string, opts: { complete?: boolean } = {}) {
  const complete = opts.complete ?? true;
  const org = await dbInternal.organization.create({
    data: {
      legalName: name,
      addressLine1: "Teststr. 1",
      postalCode: "10115",
      city: "Berlin",
      ...(complete ? { vatId: "DE777888999", taxNumber: "44/444/44444" } : {}),
    },
  });
  const prefix = `${PREFIX}${org.id.slice(-6)}-`;
  await ensureOrgMasterdata(dbInternal, org.id);
  await saveDocumentSettings(org.id, { viesCheckEnabled: false });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId: org.id, docType: "INVOICE", year: 2192 } },
    create: { orgId: org.id, docType: "INVOICE", year: 2192, currentValue: 0, prefix, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId: org.id, docType: "INVOICE", year: { not: 2192 } }, data: { isActive: false } });
  await dbInternal.webhookEndpoint.create({
    data: { orgId: org.id, url: "https://93.184.216.50/hook", secretEnc: "v1:x:x:x", eventsJson: '["invoice.finalized","payment.recorded","invoice.paid"]' },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: customer.id };
}

function invoiceInput(customerId: string, extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return createInvoiceSchema.parse({
    customerId,
    issueDate: NOW,
    deliveryDate: new Date("2192-03-05"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    ...extra,
  });
}

async function snapshot(orgId: string) {
  const range = await dbInternal.numberRange.findMany({ where: { orgId }, select: { docType: true, year: true, currentValue: true }, orderBy: [{ docType: "asc" }, { year: "asc" }] });
  return {
    invoices: await dbInternal.invoice.count({ where: { orgId } }),
    lines: await dbInternal.invoiceLine.count({ where: { invoice: { orgId } } }),
    payments: await dbInternal.payment.count({ where: { invoice: { orgId } } }),
    changeLogs: await dbInternal.changeLog.count({ where: { orgId } }),
    activity: await dbInternal.activityLog.count({ where: { orgId } }),
    deliveries: await dbInternal.webhookDelivery.count({ where: { orgId } }),
    range,
  };
}

async function trail(orgId: string) {
  const logs = await dbInternal.changeLog.findMany({ where: { orgId }, orderBy: { id: "asc" }, select: { entity: true, action: true, diffJson: true } });
  const act = await dbInternal.activityLog.findMany({ where: { orgId }, orderBy: { at: "asc" }, select: { type: true } });
  const hooks = await dbInternal.webhookDelivery.findMany({ where: { orgId }, select: { event: true } });
  return {
    pairs: logs.map((l) => `${l.entity}/${l.action}`),
    diffKeys: logs.map((l) => Object.keys(JSON.parse(l.diffJson) as Record<string, unknown>).sort()),
    activity: act.map((a) => a.type).sort(),
    events: hooks.map((h) => h.event).sort(),
  };
}

const base = { actor: "test", createdBy: "api" as const, now: NOW };

describe("createInvoiceComplete", () => {
  it("ohne Zahlung: FINALIZED mit Nummer und Snapshots", async () => {
    const { orgId, customerId } = await makeOrg("Atomar A GmbH");
    const r = await createInvoiceComplete(orgId, invoiceInput(customerId), base);
    expect(r.invoice.status).toBe("FINALIZED");
    expect(r.invoice.number).toMatch(/^D18D4-\w{6}-2192-\d+$/);
    expect(r.invoice.sellerSnapshotJson).toBeTruthy();
    expect(r.invoice.buyerSnapshotJson).toBeTruthy();
    expect(r.paymentId).toBeNull();
    expect(r.invoice.payments).toHaveLength(0);
    expect(r.invoice.lines).toHaveLength(1);
  });

  it("Teilzahlung 50,00 von 119,00: PARTIALLY_PAID, createdBy api; ohne Betrag: PAID mit offenem Betrag", async () => {
    const { orgId, customerId } = await makeOrg("Atomar B GmbH");
    const part = await createInvoiceComplete(orgId, invoiceInput(customerId), { ...base, payment: { method: "TRANSFER", amountCents: 5000 } });
    expect(part.invoice.status).toBe("PARTIALLY_PAID");
    expect(part.invoice.paidAmountCents).toBe(5000);
    expect(part.invoice.payments[0]!.createdBy).toBe("api");
    expect(part.paymentId).toBe(part.invoice.payments[0]!.id);

    const full = await createInvoiceComplete(orgId, invoiceInput(customerId), { ...base, payment: { method: "TRANSFER" } });
    expect(full.invoice.status).toBe("PAID");
    expect(full.invoice.paidAmountCents).toBe(11900);
    expect(full.invoice.payments[0]!.amountCents).toBe(11900);
  });

  it("GoBD-Paritaet: gleiche Folgen wie createDraft -> finalize -> recordPayment, Kette gueltig", async () => {
    const a = await makeOrg("Atomar C1 GmbH");
    const b = await makeOrg("Atomar C2 GmbH");
    await createInvoiceComplete(a.orgId, invoiceInput(a.customerId), { ...base, payment: { method: "TRANSFER" } });
    const draft = await createDraftInvoice(b.orgId, invoiceInput(b.customerId), { actor: "test", now: NOW });
    const fin = await finalizeInvoice(draft.id, { actor: "test", now: NOW });
    await recordPayment(fin.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: b.orgId, actor: "test", now: NOW, createdBy: "api" });

    const ta = await trail(a.orgId);
    const tb = await trail(b.orgId);
    const onlyInvoice = (p: string[]) => p.filter((x) => x.startsWith("INVOICE/"));
    expect(onlyInvoice(ta.pairs)).toEqual(["INVOICE/CREATE", "INVOICE/FINALIZE", "INVOICE/PAYMENT"]);
    expect(ta.pairs).toEqual(tb.pairs);
    expect(ta.diffKeys).toEqual(tb.diffKeys);
    expect(ta.activity).toEqual(tb.activity);
    expect(ta.events).toEqual(tb.events);
    expect(ta.events).toEqual(["invoice.finalized", "invoice.paid", "payment.recorded"]);
    expect((await verifyOrgChain(a.orgId, "UI")).valid).toBe(true);
    expect((await verifyOrgChain(b.orgId, "UI")).valid).toBe(true);
  });

  describe("Rollback", () => {
    it("Ueberzahlung: PaymentError, nichts bleibt zurueck (auch keine Nummer)", async () => {
      const { orgId, customerId } = await makeOrg("Atomar D GmbH");
      const before = await snapshot(orgId);
      await expect(createInvoiceComplete(orgId, invoiceInput(customerId), { ...base, payment: { method: "TRANSFER", amountCents: 20000 } })).rejects.toBeInstanceOf(PaymentError);
      expect(await snapshot(orgId)).toEqual(before);
    });

    it("Festschreibe-Fehler (fehlende Firmenangabe): FinalizeError, nichts bleibt zurueck", async () => {
      const { orgId, customerId } = await makeOrg("Atomar E GmbH", { complete: false });
      const before = await snapshot(orgId);
      await expect(createInvoiceComplete(orgId, invoiceInput(customerId), base)).rejects.toBeInstanceOf(FinalizeError);
      expect(await snapshot(orgId)).toEqual(before);
    });

    it("Kunde einer fremden Org: NotFoundError, nichts bleibt zurueck", async () => {
      const mine = await makeOrg("Atomar F1 GmbH");
      const other = await makeOrg("Atomar F2 GmbH");
      const before = await snapshot(mine.orgId);
      await expect(createInvoiceComplete(mine.orgId, invoiceInput(other.customerId), base)).rejects.toBeInstanceOf(NotFoundError);
      expect(await snapshot(mine.orgId)).toEqual(before);
    });

    it("beforeCommit wirft: Rollback", async () => {
      const { orgId, customerId } = await makeOrg("Atomar G GmbH");
      const before = await snapshot(orgId);
      await expect(
        createInvoiceComplete(orgId, invoiceInput(customerId), { ...base, payment: { method: "TRANSFER" }, beforeCommit: async () => { throw new Error("boom"); } }),
      ).rejects.toThrow("boom");
      expect(await snapshot(orgId)).toEqual(before);
    });
  });

  it("beforeCommit laeuft in der Transaktion: ApiIdempotency-Zeile nur nach Erfolg", async () => {
    const { orgId, customerId } = await makeOrg("Atomar H GmbH");
    await createInvoiceComplete(orgId, invoiceInput(customerId), {
      ...base,
      beforeCommit: async (tx, r) => {
        await tx.apiIdempotency.create({ data: { orgId, key: "ok-key", requestHash: "h", status: "DONE", statusCode: 201, responseJson: JSON.stringify({ id: r.invoice.id }) } });
      },
    });
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key: "ok-key" } })).toBe(1);

    await expect(
      createInvoiceComplete(orgId, invoiceInput(customerId), {
        ...base,
        payment: { method: "TRANSFER", amountCents: 99999999 },
        beforeCommit: async (tx) => {
          await tx.apiIdempotency.create({ data: { orgId, key: "fail-key", requestHash: "h" } });
        },
      }),
    ).rejects.toBeInstanceOf(PaymentError);
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key: "fail-key" } })).toBe(0);

    await expect(
      createInvoiceComplete(orgId, invoiceInput(customerId), {
        ...base,
        beforeCommit: async (tx) => {
          await tx.apiIdempotency.create({ data: { orgId, key: "late-key", requestHash: "h" } });
          throw new Error("spaet");
        },
      }),
    ).rejects.toThrow("spaet");
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key: "late-key" } })).toBe(0);
  });

  it("Hinweise: Kunde ohne E-Rechnungs-Empfaenger -> Adress-Meldung; Bestand liefert fuer Entwurf dieselbe Liste", async () => {
    const { orgId, customerId } = await makeOrg("Atomar I GmbH");
    const r = await createInvoiceComplete(orgId, invoiceInput(customerId), base);
    expect(r.warnings.join(" ")).toContain("keine elektronische Adresse");

    const draft = await createDraftInvoice(orgId, invoiceInput(customerId), { actor: "test", now: NOW });
    const legacy = await collectFinalizeWarnings(orgId, draft.id, { now: NOW });
    const forTarget = await collectFinalizeWarningsFor(orgId, { customerId, taxScheme: "REGULAR" }, { now: NOW });
    expect(forTarget).toEqual(legacy);
    expect(forTarget.length).toBeGreaterThan(0);
  });

  it("Hinweise: Karte unvollstaendig -> Hinweis aus dem Entwurf, gleiche Liste und Reihenfolge wie beim Festschreiben", async () => {
    const { orgId, customerId } = await makeOrg("Atomar K GmbH");
    const card = await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code: "CREDIT_CARD" }, select: { id: true } });
    const extra = { paymentMethodId: card.id, cardPanTruncated: "1234" } as Partial<CreateInvoiceInput>;
    const r = await createInvoiceComplete(orgId, invoiceInput(customerId, extra), base);
    expect(r.warnings.some((w) => w.includes("Kartenzahlung"))).toBe(true);

    const draft = await createDraftInvoice(orgId, invoiceInput(customerId, extra), { actor: "test", now: NOW });
    const legacy = (await collectFinalizeWarnings(orgId, draft.id, { now: NOW })).map((w) => w.message);
    expect(r.warnings).toEqual(legacy);
    expect(legacy[0]).toContain("keine elektronische Adresse");
    expect(legacy[1]).toContain("Kartenzahlung");
  });

  it("collectFinalizeWarningsFor/collectFinalizeWarnings: Ausfall eines Teils behaelt bereits gesammelte Hinweise", async () => {
    const { orgId } = await makeOrg("Atomar L GmbH");
    await saveDocumentSettings(orgId, { viesCheckEnabled: true, viesCheckOnFinalize: true });
    const customer = await dbInternal.customer.create({
      data: { orgId, name: "EU Kunde", addressLine1: "Rue 1", postalCode: "75001", city: "Paris", type: "BUSINESS", vatId: "FR12345678901" },
    });
    const spy = vi.spyOn(dbInternal.vatIdCheck, "findFirst").mockRejectedValue(new Error("db weg"));
    try {
      const forTarget = await collectFinalizeWarningsFor(orgId, { customerId: customer.id, taxScheme: "IG_LEISTUNG" }, { now: NOW });
      expect(forTarget.map((w) => w.code)).toEqual(["adresse"]);
      const draft = await createDraftInvoice(orgId, invoiceInput(customer.id, { taxScheme: "IG_LEISTUNG" } as Partial<CreateInvoiceInput>), { actor: "test", now: NOW });
      expect((await collectFinalizeWarnings(orgId, draft.id, { now: NOW })).map((w) => w.code)).toEqual(["adresse"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("Zahlung genau = Brutto (explizit): PAID, offener Betrag 0", async () => {
    const { orgId, customerId } = await makeOrg("Atomar M GmbH");
    const r = await createInvoiceComplete(orgId, invoiceInput(customerId), { ...base, payment: { method: "TRANSFER", amountCents: 11900 } });
    expect(r.invoice.status).toBe("PAID");
    expect(r.invoice.paidAmountCents).toBe(r.invoice.grossTotalCents);
    expect(r.invoice.payments).toHaveLength(1);
  });

  it("Null-Rechnung mit payment ohne Betrag: PaymentError (kein offener Betrag), Rollback", async () => {
    const { orgId, customerId } = await makeOrg("Atomar N GmbH");
    const zero = invoiceInput(customerId, {
      lines: [{ lineType: "ITEM", description: "Gratis", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 0, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    } as Partial<CreateInvoiceInput>);
    const before = await snapshot(orgId);
    await expect(createInvoiceComplete(orgId, zero, { ...base, payment: { method: "TRANSFER" } })).rejects.toBeInstanceOf(PaymentError);
    expect(await snapshot(orgId)).toEqual(before);
  });

  it("VIES-Pfad: Hinweis im Ergebnis und VatIdCheck-Zeile (trigger FINALIZE); die Zeile bleibt bei Rollback bestehen", async () => {
    const { orgId } = await makeOrg("Atomar O GmbH");
    await saveDocumentSettings(orgId, { viesCheckEnabled: true, viesCheckOnFinalize: true });
    const eu = await dbInternal.customer.create({
      data: { orgId, name: "AT Kunde", addressLine1: "Weg 1", postalCode: "1010", city: "Wien", type: "BUSINESS", countryCode: "AT", vatId: "ATU12345678", email: "a@example.org" },
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ valid: false, requestDate: "2192-03-10T10:00:00.000Z", requestIdentifier: "WAPIREQ2", userError: "INVALID" }), { status: 200 })) as unknown as typeof fetch;
    const input = invoiceInput(eu.id, {
      taxScheme: "IG_LEISTUNG",
      notes: "Steuerschuldnerschaft des Leistungsempfängers",
      lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 0, taxCategory: "K", discountPermille: 0, discountCents: 0 }],
    } as Partial<CreateInvoiceInput>);
    const r = await createInvoiceComplete(orgId, input, { ...base, fetchImpl, payment: { method: "TRANSFER", amountCents: 99999999 } }).catch((e: unknown) => e);
    // Ueberzahlung -> Rollback; der VIES-Abruf lief VOR der Transaktion und bleibt als Nachweis (append-only).
    expect(r).toBeInstanceOf(PaymentError);
    const rows = await dbInternal.vatIdCheck.findMany({ where: { orgId, customerId: eu.id }, select: { trigger: true, status: true, invoiceId: true } });
    expect(rows).toEqual([{ trigger: "FINALIZE", status: "INVALID", invoiceId: null }]);
    expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(0);

    const ok = await createInvoiceComplete(orgId, input, { ...base, fetchImpl });
    expect(ok.warnings.join(" ")).toContain("VIES meldet die USt-IdNr. ATU12345678 als ungültig");
  });

  it("collectFinalizeWarningsFor: fremder Kunde -> leere Liste", async () => {
    const mine = await makeOrg("Atomar J1 GmbH");
    const other = await makeOrg("Atomar J2 GmbH");
    expect(await collectFinalizeWarningsFor(mine.orgId, { customerId: other.customerId, taxScheme: "REGULAR" })).toEqual([]);
  });
});
