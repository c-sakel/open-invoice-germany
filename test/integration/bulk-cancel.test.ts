/**
 * Phase 18c, Task 2: Sammel-Storno — je Beleg ueber das bestehende cancelInvoice, seriell,
 * Ergebnisbericht je Beleg. Eigenes Testjahr 2170 (Invoice.number global @unique).
 */
import { beforeAll, describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { recordPayment } from "@/domain/invoice/payment";
import { createBusinessDocument } from "@/domain/document/create";
import { cancelInvoicesBulk, getCancelPreviews } from "@/domain/invoice/bulk-cancel";
import { getCancelPreview } from "@/domain/invoice/cancel-preview";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { createInvoiceSchema, recordPaymentSchema } from "@/schemas";

const NOW = new Date("2170-05-01T10:00:00.000Z");
// Belegnummern sind instanzweit eindeutig: die Fremd-Org nutzt ein eigenes Jahr.
const NOW_OTHER = new Date("2171-05-01T10:00:00.000Z");
const now = () => NOW;

let orgId: string;
let otherOrgId: string;
let customerId: string;
let otherCustomerId: string;

async function mkOrg(name: string, vat: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "55/666/77777" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: customer.id };
}

beforeAll(async () => {
  ({ orgId, customerId } = await mkOrg("Sammelstorno GmbH", "DE555666778"));
  ({ orgId: otherOrgId, customerId: otherCustomerId } = await mkOrg("Fremde Sammel GmbH", "DE888999001"));
});

async function draft(org = orgId, cust = customerId) {
  const at = org === orgId ? NOW : NOW_OTHER;
  return createDraftInvoice(
    org,
    createInvoiceSchema.parse({
      customerId: cust,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: at,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: at },
  );
}
async function finalized(org = orgId, cust = customerId) {
  const d = await draft(org, cust);
  return finalizeInvoice(d.id, { now: org === orgId ? NOW : NOW_OTHER });
}

describe("cancelInvoicesBulk", () => {
  it("storniert je Beleg einzeln, meldet Fehler je Beleg und protokolliert Batch", async () => {
    const a = await finalized();
    const b = await finalized();
    await recordPayment(b.id, recordPaymentSchema.parse({ amountCents: 5000, method: "TRANSFER", paidAt: NOW }), { now: NOW });

    const quote = await createBusinessDocument(
      orgId,
      { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] },
      { now: NOW },
    );
    const dp = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 300 }, { now: NOW });
    const c = await finalizeInvoice(dp.id, { now: NOW });
    const fin = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id }, { now: NOW });
    await finalizeInvoice(fin.id, { now: NOW });

    const res = await cancelInvoicesBulk(orgId, { ids: [c.id, a.id, b.id], reason: "Doppelt erfasst" }, { actor: "tester", now });
    expect(res.ok.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ id: c.id, code: "NOT_CANCELLABLE" });
    expect(res.failed[0].message).toContain("Schlussrechnung");
    expect(res.ok[1].refundDueCents).toBe(5000);
    expect(res.ok[0].refundDueCents).toBe(0);

    for (const o of res.ok) {
      const orig = await dbInternal.invoice.findUniqueOrThrow({ where: { id: o.id }, select: { status: true, reversedByInvoiceId: true } });
      expect(orig.status).toBe("CANCELLED");
      expect(orig.reversedByInvoiceId).toBe(o.creditNoteId);
      const cn = await dbInternal.invoice.findUniqueOrThrow({ where: { id: o.creditNoteId }, select: { type: true, status: true, number: true } });
      expect(cn.type).toBe("CREDIT_NOTE");
      expect(cn.status).not.toBe("DRAFT");
      expect(cn.number).toBe(o.creditNoteNumber);
    }
    const cAfter = await dbInternal.invoice.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } });
    expect(cAfter.status).toBe("FINALIZED");

    for (const o of res.ok) {
      const logs = await dbInternal.changeLog.findMany({ where: { orgId, entityId: o.id, action: "CANCEL" }, select: { diffJson: true } });
      expect(logs).toHaveLength(1);
      const diff = JSON.parse(logs[0].diffJson ?? "{}") as { batch?: string; reason?: string };
      expect(diff.batch).toBe(res.batchId);
      expect(diff.reason).toBe("Doppelt erfasst");
    }

    const acts = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "INVOICE_BATCH", type: "BULK_CANCELLED" }, select: { entityId: true, dataJson: true } });
    expect(acts).toHaveLength(1);
    expect(acts[0].entityId).toBe(res.batchId);
    const data = JSON.parse(acts[0].dataJson ?? "{}") as { batchId: string; reason: string; ok: { id: string; number: string | null; creditNoteNumber: string | null }[]; failed: { id: string; number: string | null; code: string }[] };
    expect(data.batchId).toBe(res.batchId);
    expect(data.reason).toBe("Doppelt erfasst");
    expect(data.ok.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(data.ok[0].creditNoteNumber).toBe(res.ok[0].creditNoteNumber);
    expect(data.failed).toEqual([{ id: c.id, number: c.number, code: "NOT_CANCELLABLE" }]);

    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);
  });

  it("validiert Eingaben: 51 Ids, leerer Grund; dedupliziert", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    await expect(cancelInvoicesBulk(orgId, { ids, reason: "x" })).rejects.toBeInstanceOf(ZodError);
    await expect(cancelInvoicesBulk(orgId, { ids: ["a"], reason: "" })).rejects.toBeInstanceOf(ZodError);
    await expect(cancelInvoicesBulk(orgId, { ids: ["a"], reason: "   " })).rejects.toBeInstanceOf(ZodError);
    const a = await finalized();
    const res = await cancelInvoicesBulk(orgId, { ids: [a.id, a.id], reason: "Dublette" }, { now });
    expect(res.ok).toHaveLength(1);
    expect(res.failed).toHaveLength(0);
  });

  it("Entwurf, bereits storniert, fremde und erfundene Id", async () => {
    const d = await draft();
    const done = await finalized();
    await cancelInvoicesBulk(orgId, { ids: [done.id], reason: "erst" }, { now });
    const foreign = await finalized(otherOrgId, otherCustomerId);

    const res = await cancelInvoicesBulk(orgId, { ids: [d.id, done.id, foreign.id, "erfunden-123"], reason: "Test" }, { now });
    expect(res.ok).toHaveLength(0);
    const by = new Map(res.failed.map((f) => [f.id, f]));
    expect(by.get(d.id)).toMatchObject({ code: "NOT_CANCELLABLE", message: "Entwürfe werden gelöscht, nicht storniert." });
    expect(by.get(done.id)?.code).toBe("NOT_CANCELLABLE");
    expect(by.get(foreign.id)).toMatchObject({ code: "NOT_FOUND", number: null });
    expect(by.get("erfunden-123")).toMatchObject({ code: "NOT_FOUND", number: null });
    expect(by.get(foreign.id)?.message).toBe(by.get("erfunden-123")?.message);
    const f = await dbInternal.invoice.findUniqueOrThrow({ where: { id: foreign.id }, select: { status: true } });
    expect(f.status).toBe("FINALIZED");
  });

  it("nebenlaeufige Aufrufe: je Beleg genau eine Gutschrift", async () => {
    const x = await finalized();
    const y = await finalized();
    const [r1, r2] = await Promise.all([
      cancelInvoicesBulk(orgId, { ids: [x.id, y.id], reason: "Parallel" }, { now }),
      cancelInvoicesBulk(orgId, { ids: [x.id, y.id], reason: "Parallel" }, { now }),
    ]);
    expect(r1.ok.length + r2.ok.length).toBe(2);
    const failed = [...r1.failed, ...r2.failed];
    expect(failed).toHaveLength(2);
    for (const f of failed) {
      expect(f.code).toBe("NOT_CANCELLABLE");
      expect(f.message).toContain("bereits storniert");
    }
    for (const id of [x.id, y.id]) {
      const n = await dbInternal.invoice.count({ where: { correctsInvoiceId: id, type: "CREDIT_NOTE" } });
      expect(n).toBe(1);
    }
  });
});

describe("getCancelPreviews", () => {
  it("liefert je Id dasselbe wie getCancelPreview; fremde Id in missing", async () => {
    const a = await finalized();
    const foreign = await finalized(otherOrgId, otherCustomerId);
    const res = await getCancelPreviews(orgId, { ids: [a.id, foreign.id] });
    expect(res.previews).toEqual([await getCancelPreview(a.id, orgId)]);
    expect(res.missing).toEqual([foreign.id]);
  });
});
