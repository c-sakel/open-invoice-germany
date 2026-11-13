/**
 * Zahlungskorrektur per Gegenbuchung (Phase 16a). Eigenes Jahr (2049): Invoice.number ist
 * global @unique und test.db wird ueber die Testlaufzeit geteilt.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment, PaymentError } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { getCancelPreview } from "@/domain/invoice/cancel-preview";
import { dunningCandidates } from "@/domain/dunning/auto";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { NotFoundError } from "@/domain/errors";
import { buildTimeline } from "@/domain/timeline/build";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let otherOrgId: string;
let customerId: string;
const FIX_DATE = new Date("2049-03-01T10:00:00.000Z");
const LATER = new Date("2049-12-01T10:00:00.000Z");

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const mk = async (name: string) =>
    dbInternal.organization.create({
      data: { legalName: name, addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    });
  orgId = (await mk("Gegenbuchung GmbH")).id;
  otherOrgId = (await mk("Fremd GmbH")).id;
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await ensureOrgMasterdata(dbInternal, otherOrgId);
});

// 100,00 EUR netto + 19 % = 119,00 EUR brutto; optional 2 % Skonto binnen 10 Tagen.
async function invoice(skonto = false): Promise<string> {
  const input = {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    ...(skonto ? { skonto1Permille: 20, skonto1Days: 10 } : {}),
    issueDate: FIX_DATE, deliveryDate: new Date("2049-02-25"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input, { now: FIX_DATE });
  return (await finalizeInvoice(draft.id, { now: FIX_DATE })).id;
}

async function pay(invoiceId: string, amountCents: number, extra: { applySkonto?: boolean; method?: string; paidAt?: Date } = {}) {
  await recordPayment(
    invoiceId,
    { amountCents, method: extra.method ?? "TRANSFER", isSkonto: false, applySkonto: extra.applySkonto ?? false, paidAt: extra.paidAt },
    { orgId, now: FIX_DATE },
  );
  return dbInternal.payment.findFirstOrThrow({ where: { invoiceId, kind: "PAYMENT", method: extra.method ?? "TRANSFER" }, orderBy: { createdAt: "asc" } });
}

const inv = (id: string) => dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmountCents: true } });

describe("reversePayment", () => {
  it("volle Gegenbuchung: negative Zeile, paid 0, FINALIZED, ChangeLog, Zeile bleibt", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    const res = await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "tester", orgId, now: LATER });
    expect(res.reversal).toMatchObject({ kind: "REVERSAL", amountCents: -11900, reversesPaymentId: p.id, reason: "Fehlbuchung", createdBy: "user" });
    expect(res.invoiceStatus).toBe("FINALIZED");
    expect(res.paidAmountCents).toBe(0);
    expect(await inv(id)).toEqual({ status: "FINALIZED", paidAmountCents: 0 });
    expect(await dbInternal.payment.findUniqueOrThrow({ where: { id: p.id }, select: { amountCents: true } })).toEqual({ amountCents: 11900 });
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entityId: id, action: "PAYMENT_REVERSAL" } });
    expect(JSON.parse(log.diffJson ?? "{}")).toEqual({ paymentId: p.id, amountCents: 11900, reason: "Fehlbuchung", paidAmountCents: 0, status: "FINALIZED" });
    expect(await dbInternal.activityLog.count({ where: { entityId: id, type: "PAYMENT_REVERSED" } })).toBe(1);
  });

  it("mit versendeter E-Mail -> SENT", async () => {
    const id = await invoice();
    await dbInternal.emailLog.create({ data: { orgId, docType: "INVOICE", docId: id, subject: "x", bodySnapshot: "x", status: "SENT" } });
    const p = await pay(id, 11900);
    expect((await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER })).invoiceStatus).toBe("SENT");
  });

  it("Phase 16d: LIVE-Postauftrag zaehlt als ausgegeben (-> SENT), Trockenlauf nicht (-> FINALIZED)", async () => {
    const job = (id: string, mode: string, status: string) => ({
      orgId, docType: "INVOICE", docId: id, invoiceId: id, docNumber: `RE-${id}`, mode, trigger: "USER", status,
      filename: `${id}-${mode}-${status}.pdf`, pages: 1, color: "1", duplex: false, shipping: "national", pdfSha256: "a".repeat(64), base64Md5: "b".repeat(32), createdBy: "t",
    });
    const live = await invoice();
    await dbInternal.postalJob.create({ data: job(live, "LIVE", "QUEUED"), select: { id: true } });
    const p1 = await pay(live, 11900);
    expect((await reversePayment(p1.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER })).invoiceStatus).toBe("SENT");

    const dry = await invoice();
    await dbInternal.postalJob.create({ data: job(dry, "DRY_RUN", "DRY_RUN"), select: { id: true } });
    const p2 = await pay(dry, 11900);
    expect((await reversePayment(p2.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER })).invoiceStatus).toBe("FINALIZED");
  });

  it("Teil-Gegenbuchung: PARTIALLY_PAID, Rest-Default danach 6900, weitere Ueberschreitung 409", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    const r1 = await reversePayment(p.id, { amountCents: 5000, reason: "Teilerstattung" }, { actor: "t", orgId, now: LATER });
    expect(r1.invoiceStatus).toBe("PARTIALLY_PAID");
    expect(r1.paidAmountCents).toBe(6900);
    await expect(reversePayment(p.id, { amountCents: 6901, reason: "zu viel" }, { actor: "t", orgId, now: LATER })).rejects.toThrow(PaymentError);
    const r2 = await reversePayment(p.id, { reason: "Rest" }, { actor: "t", orgId, now: LATER });
    expect(r2.reversal.amountCents).toBe(-6900);
    expect(r2.paidAmountCents).toBe(0);
  });

  it("zweite volle Gegenbuchung -> PaymentError (409)", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    await expect(reversePayment(p.id, { reason: "nochmal" }, { actor: "t", orgId, now: LATER })).rejects.toThrow(PaymentError);
    expect((await inv(id)).paidAmountCents).toBe(0);
  });

  it("Skonto: volle Gegenbuchung bucht Zahlung und Skontozahlung zurueck", async () => {
    const id = await invoice(true);
    const p = await pay(id, 11662, { applySkonto: true, paidAt: new Date("2049-03-05T00:00:00.000Z") });
    expect(await inv(id)).toEqual({ status: "PAID", paidAmountCents: 11900 });
    const res = await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    expect(res.skontoReversal).toMatchObject({ amountCents: -238, method: "SKONTO", isSkonto: true, kind: "REVERSAL" });
    expect(res.paidAmountCents).toBe(0);
    expect((await inv(id)).status).toBe("FINALIZED");
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entityId: id, action: "PAYMENT_REVERSAL" } });
    expect(JSON.parse(log.diffJson ?? "{}").amountCents).toBe(11900);
  });

  it("CREDIT_NOTE-Verrechnung -> 409", async () => {
    const id = await invoice();
    const p = await dbInternal.payment.create({ data: { invoiceId: id, amountCents: 1000, method: "CREDIT_NOTE" } });
    await expect(reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId })).rejects.toThrow(PaymentError);
  });

  it("fremde Organisation oder unbekannte Zahlung -> 404", async () => {
    const id = await invoice();
    const p = await pay(id, 1000);
    await expect(reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId: otherOrgId })).rejects.toThrow(NotFoundError);
    await expect(reversePayment("gibtsnicht", { reason: "Fehlbuchung" }, { actor: "t", orgId })).rejects.toThrow(NotFoundError);
  });

  it("Gegenbuchung einer REVERSAL-Zeile -> 409", async () => {
    const id = await invoice();
    const p = await pay(id, 1000);
    const { reversal } = await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId });
    await expect(reversePayment(reversal.id, { reason: "Fehlbuchung" }, { actor: "t", orgId })).rejects.toThrow(PaymentError);
  });

  it("reason zu kurz -> Zod-Fehler", async () => {
    const id = await invoice();
    const p = await pay(id, 1000);
    await expect(reversePayment(p.id, { reason: "ab" }, { actor: "t", orgId })).rejects.toThrow(/too_small|Too small|least 3/i);
  });

  it("Webhook payment.reversed in der Outbox", async () => {
    const ep = await createWebhookEndpoint(orgId, { url: "https://93.184.216.34/hook", events: ["payment.reversed"] }, { now: FIX_DATE });
    const id = await invoice();
    const p = await pay(id, 11900);
    const { reversal } = await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    const d = await dbInternal.webhookDelivery.findMany({ where: { endpointId: ep.id, event: "payment.reversed" } });
    expect(d).toHaveLength(1);
    expect(d[0].objectId).toBe(reversal.id);
    const payload = JSON.parse(d[0].dataJson) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: "REVERSAL", reversesPaymentId: p.id, reason: "Fehlbuchung", amountCents: -11900 });
  });

  it("Belegkette kennzeichnet Gegenbuchungen", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    const { buildDocumentChain } = await import("@/domain/document/chain");
    const { root } = await buildDocumentChain(orgId, "INVOICE", id);
    const labels = root.children.filter((c) => c.type === "PAYMENT").map((c) => c.label);
    expect(labels.some((l) => l.startsWith("Gegenbuchung"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Zahlung"))).toBe(true);
  });

  it("Mahnwesen: Rechnung ist nach voller Gegenbuchung wieder Mahnkandidat", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    expect((await dunningCandidates(orgId, LATER)).map((c) => c.id)).not.toContain(id);
    await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    expect((await dunningCandidates(orgId, LATER)).map((c) => c.id)).toContain(id);
  });

  it("stornierte Rechnung: Status bleibt CANCELLED, Storno-Vorschau zeigt 0 bezahlte Cent", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    await cancelInvoice(id, { orgId, now: FIX_DATE });
    expect((await getCancelPreview(id, orgId)).paidCents).toBe(11900);
    const res = await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    expect(res.invoiceStatus).toBe("CANCELLED");
    expect(await inv(id)).toEqual({ status: "CANCELLED", paidAmountCents: 0 });
    const preview = await getCancelPreview(id, orgId);
    expect(preview.paidCents).toBe(0);
    expect(preview.refundDueCents).toBe(0);
  });

  it("parallele Gegenbuchungen derselben Zahlung: Summe ueberschreitet den Betrag nie", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    const results = await Promise.allSettled([
      reversePayment(p.id, { amountCents: 8000, reason: "parallel A" }, { actor: "t", orgId, now: LATER }),
      reversePayment(p.id, { amountCents: 8000, reason: "parallel B" }, { actor: "t", orgId, now: LATER }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const sum = await dbInternal.payment.aggregate({ where: { reversesPaymentId: p.id }, _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(-8000);
    expect((await inv(id)).paidAmountCents).toBe(3900);
  });

  it("createdBy: recordPayment setzt api/mcp, Gegenbuchung uebernimmt createdBy", async () => {
    const id = await invoice();
    await recordPayment(id, { amountCents: 1000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: FIX_DATE, createdBy: "api" });
    await recordPayment(id, { amountCents: 2000, method: "CASH", isSkonto: false, applySkonto: false }, { orgId, now: FIX_DATE, createdBy: "mcp" });
    const rows = await dbInternal.payment.findMany({ where: { invoiceId: id }, select: { id: true, method: true, createdBy: true } });
    expect(rows.find((r) => r.method === "TRANSFER")?.createdBy).toBe("api");
    const cash = rows.find((r) => r.method === "CASH");
    expect(cash?.createdBy).toBe("mcp");
    const res = await reversePayment(cash!.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, createdBy: "mcp" });
    expect(res.reversal.createdBy).toBe("mcp");
  });

  it("Skonto: Webhook je Gegenbuchungszeile; Teil-Gegenbuchung laesst die Skontobuchung stehen", async () => {
    const ep = await createWebhookEndpoint(orgId, { url: "https://93.184.216.35/hook", events: ["payment.reversed"] }, { now: FIX_DATE });
    const id = await invoice(true);
    const p = await pay(id, 11662, { applySkonto: true, paidAt: new Date("2049-03-05T00:00:00.000Z") });
    const part = await reversePayment(p.id, { amountCents: 1000, reason: "Teilerstattung" }, { actor: "t", orgId, now: LATER });
    expect(part.skontoReversal).toBeUndefined();
    expect(part.paidAmountCents).toBe(10900);
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id } })).toBe(1);
    const rest = await reversePayment(p.id, { reason: "Rest" }, { actor: "t", orgId, now: LATER });
    expect(rest.skontoReversal?.amountCents).toBe(-238);
    expect(rest.paidAmountCents).toBe(0);
    const deliveries = await dbInternal.webhookDelivery.findMany({ where: { endpointId: ep.id }, select: { objectId: true } });
    expect(deliveries.map((d) => d.objectId).sort()).toEqual([part.reversal.id, rest.reversal.id, rest.skontoReversal!.id].sort());
  });

  it("Zeitleiste: Gegenbuchung als 'Zahlung korrigiert (Gegenbuchung)' mit Grund", async () => {
    const id = await invoice();
    const p = await pay(id, 11900);
    await reversePayment(p.id, { reason: "Fehlbuchung" }, { actor: "t", orgId, now: LATER });
    const entries = (await buildTimeline(orgId, { kind: "INVOICE", id }, LATER)).filter((e) => e.kind === "payment");
    expect(entries.map((e) => e.label)).toEqual(["Zahlung erfasst", "Zahlung korrigiert (Gegenbuchung)"]);
    expect(entries[1].detail).toContain("Fehlbuchung");
  });
});
