/**
 * Zuordnungsvorschlaege aus der Datenbank: nur offene Rechnungen der eigenen Organisation,
 * gelernter Gegenkonto-Hinweis, Teilzahlung. Testjahr 2201.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createInvoiceSchema, recordPaymentSchema } from "@/schemas";
import { importBankStatement } from "@/domain/bank/import";
import { bankIbanHash, loadMatchContext, suggestionsFor, suggestionsForPage } from "@/domain/bank/suggest";
import { buildCamt } from "../helpers/camt-builder";

const NOW = new Date("2201-05-02T10:00:00.000Z");
const ACCOUNT = "DE89370400440532013000";
const PAYER_IBAN = "GB82WEST12345698765432";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let otherCustomerId: string;

async function mkOrg(name: string, tag: string): Promise<{ orgId: string; customerId: string }> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE123456789", taxNumber: "44/444/44444" },
    select: { id: true },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  const prefix = `S2201${tag}-${org.id.slice(-6)}-`;
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId: org.id, docType: "INVOICE", year: 0 } },
    create: { orgId: org.id, docType: "INVOICE", year: 0, currentValue: 0, prefix, pattern: "{PREFIX}{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId: org.id, docType: "INVOICE", year: { not: 0 } }, data: { isActive: false } });
  const c = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Muster Kundschaft GmbH", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    select: { id: true },
  });
  return { orgId: org.id, customerId: c.id };
}

async function invoice(org: string, cust: string, type: "INVOICE" | "CREDIT_NOTE" = "INVOICE", finalize = true): Promise<{ id: string; number: string | null }> {
  const draft = await createDraftInvoice(
    org,
    createInvoiceSchema.parse({
      customerId: cust,
      type,
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: NOW,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  if (!finalize) return { id: draft.id, number: null };
  const f = await finalizeInvoice(draft.id, { now: NOW });
  return { id: f.id, number: f.number };
}

/** Importiert Umsaetze (je Aufruf andere Tage, damit nichts als Doppel gilt) und liefert ihre Ids in Eingabereihenfolge. */
let dayOffset = 3;
async function importTx(org: string, txs: Array<{ cents: number; remittance: string; name?: string }>): Promise<string[]> {
  const xml = buildCamt({
    format: "053",
    version: 8,
    iban: ACCOUNT,
    entries: txs.map((t, i) => ({
      date: `2201-06-${String(dayOffset + i).padStart(2, "0")}`,
      txs: [{ amountCents: t.cents, name: t.name ?? "Unbekannt", iban: PAYER_IBAN, remittance: t.remittance }],
    })),
  });
  const result = await importBankStatement(org, new TextEncoder().encode(xml), { actor: "tester", source: "UI", now: NOW });
  dayOffset += txs.length;
  const rows = await dbInternal.bankTransaction.findMany({ where: { orgId: org, importId: result.importId! }, select: { id: true }, orderBy: { bookingDate: "asc" } });
  return rows.map((r) => r.id);
}

describe("Zuordnungsvorschlaege (Datenbank)", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-fuer-bank-vorschlaege-0123456789";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    ({ orgId, customerId } = await mkOrg("Bank Vorschlag GmbH", "A"));
    ({ orgId: otherOrgId, customerId: otherCustomerId } = await mkOrg("Bank Vorschlag Fremd GmbH", "B"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("schlaegt nur offene Rechnungen der Organisation vor", async () => {
    const open = await invoice(orgId, customerId);
    const paid = await invoice(orgId, customerId);
    await recordPayment(paid.id, recordPaymentSchema.parse({ amountCents: 11900 }), { orgId, now: NOW });
    const cancelled = await invoice(orgId, customerId);
    await cancelInvoice(cancelled.id, { orgId, now: NOW });
    const draft = await invoice(orgId, customerId, "INVOICE", false);
    const credit = await invoice(orgId, customerId, "CREDIT_NOTE");
    const foreign = await invoice(otherOrgId, otherCustomerId);

    const ctx = await loadMatchContext(orgId);
    const ids = ctx.invoices.map((i) => i.id);
    expect(ids).toContain(open.id);
    for (const gone of [paid.id, cancelled.id, draft.id, credit.id, foreign.id]) expect(ids).not.toContain(gone);

    const [txId] = await importTx(orgId, [{ cents: 11900, remittance: `Rechnung ${open.number} danke ${foreign.number} ${paid.number}` }]);
    const suggestions = await suggestionsFor(orgId, txId!);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.allocations[0]!.invoiceId).toBe(open.id);
    expect(suggestions[0]!.confidence).toBe("SICHER");
    const page = await suggestionsForPage(orgId, [txId!]);
    expect(page.get(txId!)).toEqual(suggestions);
    expect(await suggestionsFor(otherOrgId, txId!)).toEqual([]);
  });

  it("Teilzahlung reduziert den offenen Rest", async () => {
    const part = await invoice(orgId, customerId);
    await recordPayment(part.id, recordPaymentSchema.parse({ amountCents: 4000 }), { orgId, now: NOW });
    const ctx = await loadMatchContext(orgId);
    expect(ctx.invoices.find((i) => i.id === part.id)!.openCents).toBe(7900);
    const ids = await importTx(orgId, [{ cents: 7900, remittance: `Rest ${part.number}` }]);
    const target = ids[0]!;
    const s = await suggestionsFor(orgId, target);
    expect(s[0]!.allocations[0]).toMatchObject({ invoiceId: part.id, amountCents: 7900 });
    expect(s[0]!.confidence).toBe("SICHER");
  });

  it("der gelernte Gegenkonto-Hinweis wirkt, auch ohne Rechnungsnummer", async () => {
    const hinted = await invoice(orgId, customerId);
    const hash = bankIbanHash(PAYER_IBAN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(PAYER_IBAN);
    await dbInternal.bankCounterpartyHint.create({ data: { orgId, ibanHash: hash!, customerId, lastUsedAt: NOW } });
    const ids = await importTx(orgId, [{ cents: 11900, remittance: "Ohne Referenz" }]);
    const s = await suggestionsFor(orgId, ids[0]!);
    const forInvoice = s.find((x) => x.allocations[0]!.invoiceId === hinted.id);
    expect(forInvoice!.reasons).toContain("IBAN_HINT");
    expect(forInvoice!.confidence).toBe("MOEGLICH");
  });
});
