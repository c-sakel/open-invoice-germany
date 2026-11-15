/**
 * Online-Zahlung: Bezahllink beim Festschreiben (alle Wege), nachtraeglich, Deaktivieren/Reaktivieren,
 * Storno. Testjahr 2215, je Test eigene Organisation (Belegnummern sind instanzweit eindeutig).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createInvoiceComplete } from "@/domain/invoice/create-complete";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringInvoice } from "../helpers/emit-recurring";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { createPayLinkWithinTx, disablePayLink, ensurePayLink, resolvePayLinkByToken, revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { createInvoiceSchema, createRecurringSchema, type CreateInvoiceInput } from "@/schemas";

const NOW = new Date("2215-03-10T10:00:00.000Z");
const KEY = "test_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

beforeAll(() => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = "https://rechnung.example.org";
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});

interface Setup {
  provider?: "MOLLIE" | "NONE";
  accountEnabled?: boolean;
  customerChoice?: string | null;
  showOnPdf?: boolean;
  mode?: "TEST" | "LIVE";
}

async function makeOrg(name: string, s: Setup = {}) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  const prefix = `OP15-${orgId.slice(-6)}-`;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2215 } },
    create: { orgId, docType: "INVOICE", year: 2215, currentValue: 0, prefix, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 2215 } }, data: { isActive: false } });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "CREDIT_NOTE", year: 2215 } },
    create: { orgId, docType: "CREDIT_NOTE", year: 2215, currentValue: 0, prefix: `OG15-${orgId.slice(-6)}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix: `OG15-${orgId.slice(-6)}-`, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "CREDIT_NOTE", year: { not: 2215 } }, data: { isActive: false } });
  await dbInternal.paymentProviderSettings.create({
    data: { orgId, defaultProvider: s.provider ?? "MOLLIE", showOnPdf: s.showOnPdf ?? true },
  });
  await dbInternal.paymentProviderAccount.create({
    data: {
      orgId,
      provider: "MOLLIE",
      enabled: s.accountEnabled ?? true,
      mode: s.mode ?? "LIVE",
      apiKeyEnc: encryptSecret(KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
      webhookPathId: `wh-${orgId}`,
      lastTestOk: true,
    },
  });
  const customer = await dbInternal.customer.create({
    data: {
      orgId,
      name: "Kunde AG",
      addressLine1: "Marktplatz 2",
      postalCode: "20095",
      city: "Hamburg",
      type: "BUSINESS",
      onlinePaymentProvider: s.customerChoice ?? null,
    },
  });
  const transfer = await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code: "TRANSFER" }, select: { id: true } });
  return { orgId, customerId: customer.id, transferId: transfer.id };
}

function input(customerId: string, extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return createInvoiceSchema.parse({
    customerId,
    issueDate: NOW,
    deliveryDate: new Date("2215-03-05"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    ...extra,
  });
}

async function finalized(orgId: string, customerId: string, extra: Partial<CreateInvoiceInput> = {}) {
  const d = await createDraftInvoice(orgId, input(customerId, extra), { now: NOW });
  return finalizeInvoice(d.id, { now: NOW });
}

const linkOf = (invoiceId: string) =>
  dbInternal.invoicePayLink.findUnique({ where: { invoiceId }, select: { id: true, status: true, onDocument: true, provider: true, disabledReason: true, orgId: true } });

describe("Festschreiben mit Voreinstellung", () => {
  it("Organisationsvorgabe MOLLIE: Link mit onDocument, ChangeLog-Diff und Protokoll ohne Token", async () => {
    const { orgId, customerId } = await makeOrg("Link A GmbH");
    const inv = await finalized(orgId, customerId);
    const link = await linkOf(inv.id);
    expect(link).toMatchObject({ status: "ACTIVE", onDocument: true, provider: "MOLLIE", orgId });
    const url = await revealPayLinkUrl(orgId, inv.id, "https://rechnung.example.org/");
    expect(url).toMatch(/^https:\/\/rechnung\.example\.org\/zahlen\/[A-Za-z0-9_-]{43}$/);
    const token = url!.split("/zahlen/")[1]!;
    const logs = await dbInternal.changeLog.findMany({ where: { orgId, entityId: inv.id }, select: { diffJson: true } });
    const fin = logs.map((l) => JSON.parse(l.diffJson) as Record<string, unknown>).find((d) => d.status === "FINALIZED");
    expect(fin?.payLink).toEqual({ provider: "MOLLIE", onDocument: true });
    const act = await dbInternal.activityLog.findMany({ where: { orgId }, select: { type: true, dataJson: true } });
    expect(act.some((a) => a.type === "PAY_LINK_CREATED")).toBe(true);
    expect(JSON.stringify([logs, act])).not.toContain(token);
    expect((await resolvePayLinkByToken(token))?.invoiceId).toBe(inv.id);
    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);
  });

  it("Testmodus-Konto: Link nur intern, nie auf dem Beleg (onDocument false)", async () => {
    const { orgId, customerId } = await makeOrg("Link T GmbH", { mode: "TEST" });
    const inv = await finalized(orgId, customerId);
    expect(await linkOf(inv.id)).toMatchObject({ status: "ACTIVE", onDocument: false });
    expect(await revealPayLinkUrl(orgId, inv.id, "https://rechnung.example.org")).toMatch(/\/zahlen\//);
  });

  it("showOnPdf aus: Link ohne onDocument", async () => {
    const { orgId, customerId } = await makeOrg("Link B GmbH", { showOnPdf: false });
    const inv = await finalized(orgId, customerId);
    expect(await linkOf(inv.id)).toMatchObject({ onDocument: false });
  });

  it("Kunde NONE: kein Link; Zahlungsart MOLLIE schlaegt Kunde NONE", async () => {
    const { orgId, customerId, transferId } = await makeOrg("Link C GmbH", { customerChoice: "NONE" });
    const none = await finalized(orgId, customerId);
    expect(await linkOf(none.id)).toBeNull();
    await dbInternal.paymentMethod.update({ where: { id: transferId }, data: { onlineProvider: "MOLLIE" } });
    const viaMethod = await finalized(orgId, customerId, { paymentMethodId: transferId });
    expect(await linkOf(viaMethod.id)).toMatchObject({ status: "ACTIVE" });
  });

  it("Konto aus oder Organisationsvorgabe NONE: kein Link", async () => {
    const off = await makeOrg("Link D GmbH", { accountEnabled: false });
    expect(await linkOf((await finalized(off.orgId, off.customerId)).id)).toBeNull();
    const none = await makeOrg("Link E GmbH", { provider: "NONE" });
    expect(await linkOf((await finalized(none.orgId, none.customerId)).id)).toBeNull();
  });

  it("Storno: Original-Link deaktiviert (INVOICE_CANCELLED), Storno-Beleg ohne Link, keine Reaktivierung", async () => {
    const { orgId, customerId } = await makeOrg("Link F GmbH");
    const inv = await finalized(orgId, customerId);
    await cancelInvoice(inv.id, { orgId, now: NOW });
    expect(await linkOf(inv.id)).toMatchObject({ status: "DISABLED", disabledReason: "INVOICE_CANCELLED" });
    expect(await dbInternal.invoicePayLink.count({ where: { orgId } })).toBe(1);
    await expect(ensurePayLink(orgId, inv.id, "tester")).rejects.toMatchObject({ code: "LINK_CANCELLED" });
    expect(await revealPayLinkUrl(orgId, inv.id, "https://rechnung.example.org")).toBeNull();
    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);
  });

  it("Anlegen+Festschreiben+Vollzahlung (createInvoiceComplete) deaktiviert den Link nach Vollzahlung", async () => {
    const { orgId, customerId } = await makeOrg("Link G GmbH");
    const r = await createInvoiceComplete(orgId, input(customerId), { actor: "test", createdBy: "api", now: NOW, payment: { method: "TRANSFER" } });
    expect(r.invoice.status).toBe("PAID");
    expect(await linkOf(r.invoice.id)).toMatchObject({ status: "DISABLED", disabledReason: "INVOICE_PAID" });
    expect(await revealPayLinkUrl(orgId, r.invoice.id, "https://rechnung.example.org")).toBeNull();
  });

  it("Abo-Lauf mit Auto-Festschreiben erzeugt den Link", async () => {
    const { orgId, customerId } = await makeOrg("Link H GmbH");
    const rec = await createRecurring(
      orgId,
      createRecurringSchema.parse({
        customerId,
        title: "Abo",
        startDate: NOW,
        autoFinalize: true,
        lines: [{ description: "Abo", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 5000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      }),
    );
    const emitted = await emitRecurringInvoice(rec.id, { now: NOW });
    expect(await linkOf(emitted.invoiceId)).toMatchObject({ status: "ACTIVE" });
  });
});

describe("Bestandsrechnung, Deaktivieren, Reaktivieren", () => {
  it("nachtraeglich: onDocument false, idempotent; deaktivieren/reaktivieren; Fremd-Org -> NOT_FOUND", async () => {
    const { orgId, customerId } = await makeOrg("Link I GmbH", { accountEnabled: false });
    const inv = await finalized(orgId, customerId);
    expect(await linkOf(inv.id)).toBeNull();
    await expect(ensurePayLink(orgId, inv.id, "tester")).rejects.toMatchObject({ code: "ACCOUNT_OFF" });
    await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { enabled: true } });
    const first = await ensurePayLink(orgId, inv.id, "tester");
    expect(first).toMatchObject({ status: "ACTIVE", onDocument: false, provider: "MOLLIE" });
    expect((await ensurePayLink(orgId, inv.id, "tester")).id).toBe(first.id);
    const off = await disablePayLink(orgId, inv.id, "tester");
    expect(off).toMatchObject({ status: "DISABLED", disabledReason: "MANUAL" });
    expect(await revealPayLinkUrl(orgId, inv.id, "https://rechnung.example.org")).toBeNull();
    const again = await ensurePayLink(orgId, inv.id, "tester");
    expect(again).toMatchObject({ id: first.id, status: "ACTIVE", disabledAt: null, disabledReason: null });
    const other = await makeOrg("Link J GmbH");
    await expect(ensurePayLink(other.orgId, inv.id, "tester")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const types = (await dbInternal.activityLog.findMany({ where: { orgId, entityId: inv.id }, select: { type: true } })).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["PAY_LINK_CREATED", "PAY_LINK_DISABLED", "PAY_LINK_REACTIVATED"]));
  });

  it("ein Link gehoert nur zur Organisation seiner Rechnung", async () => {
    const a = await makeOrg("Link L GmbH", { accountEnabled: false });
    const b = await makeOrg("Link M GmbH");
    const inv = await finalized(a.orgId, a.customerId);
    await expect(
      dbInternal.$transaction((tx) => createPayLinkWithinTx(tx, { orgId: b.orgId, invoiceId: inv.id, provider: "MOLLIE", onDocument: false, actor: "t", now: NOW })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await linkOf(inv.id)).toBeNull();
  });

  it("Entwurf und Gutschrift erhalten keinen Link; falsches Token wird nicht aufgeloest", async () => {
    const { orgId, customerId } = await makeOrg("Link K GmbH");
    const d = await createDraftInvoice(orgId, input(customerId), { now: NOW });
    await expect(ensurePayLink(orgId, d.id, "tester")).rejects.toMatchObject({ code: "INVOICE_STATE" });
    expect(await resolvePayLinkByToken("A".repeat(43))).toBeNull();
    expect(await resolvePayLinkByToken("zu-kurz")).toBeNull();
    expect(await resolvePayLinkByToken("")).toBeNull();
  });
});
