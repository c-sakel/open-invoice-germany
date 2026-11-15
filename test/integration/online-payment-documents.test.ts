/**
 * Online-Bezahllink auf Belegen: PDF, E-Rechnung (BT-20/BT-81), Mail-Platzhalter und Kundenportal.
 * Testjahr 2219, je Fall eigene Organisation (Belegnummern sind instanzweit eindeutig). Kein Netz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createDunning } from "@/domain/dunning/create";
import { disablePayLink, revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { buildTemplateContext } from "@/domain/email/context";
import { savePortalSettings } from "@/domain/portal/settings";
import { createPortalLink, resolvePortalToken } from "@/domain/portal/link";
import { loadPortalView } from "@/domain/portal/view";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { createInvoiceSchema } from "@/schemas";
import { FAKE_LIVE_KEY, FAKE_TEST_KEY } from "../helpers/mollie-fake";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";

const YEAR = 2219;
const NOW = new Date(`${YEAR}-03-10T10:00:00.000Z`);
const LATER = new Date(`${YEAR}-06-15T10:00:00.000Z`);
const BASE = "https://rechnung.example.org";
const IBAN = "DE89370400440532013000";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

beforeAll(() => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = BASE;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});

let orgCounter = 0;

async function setup(opts: { mode?: "TEST" | "LIVE" } = {}) {
  const mode = opts.mode ?? "LIVE";
  orgCounter += 1;
  const org = await dbInternal.organization.create({
    data: { legalName: `Bezahllink Beleg ${orgCounter} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444", iban: IBAN, bic: "COBADEFFXXX" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  for (const [docType, prefix] of [["INVOICE", "OD19"], ["CREDIT_NOTE", "OE19"]] as const) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: YEAR } },
      create: { orgId, docType, year: YEAR, currentValue: 0, prefix: `${prefix}-${orgId.slice(-6)}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: { currentValue: 0, prefix: `${prefix}-${orgId.slice(-6)}-`, isActive: true },
    });
    await dbInternal.numberRange.updateMany({ where: { orgId, docType, year: { not: YEAR } }, data: { isActive: false } });
  }
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "MOLLIE" } });
  await dbInternal.paymentProviderAccount.create({
    data: {
      orgId,
      provider: "MOLLIE",
      enabled: true,
      mode,
      apiKeyEnc: encryptSecret(mode === "LIVE" ? FAKE_LIVE_KEY : FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
      webhookPathId: `wh-${orgId}`,
      lastTestOk: true,
    },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Beleg Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId, customerId: customer.id };
}
type S = Awaited<ReturnType<typeof setup>>;

async function invoice(s: S, o: { skonto?: boolean; methodCode?: string; language?: "de" | "en" } = {}): Promise<{ id: string; url: string | null }> {
  const method = o.methodCode ? await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId: s.orgId, code: o.methodCode }, select: { id: true } }) : null;
  const d = await createDraftInvoice(
    s.orgId,
    createInvoiceSchema.parse({
      customerId: s.customerId,
      issueDate: NOW,
      dueDate: new Date(`${YEAR}-04-10`),
      deliveryDate: new Date(`${YEAR}-03-05`),
      ...(o.skonto ? { skonto1Permille: 20, skonto1Days: 10 } : {}),
      ...(method ? { paymentMethodId: method.id } : {}),
      ...(o.language ? { language: o.language } : {}),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
  const inv = await finalizeInvoice(d.id, { now: NOW });
  return { id: inv.id, url: await revealPayLinkUrl(s.orgId, inv.id, BASE) };
}

async function docs(s: S, id: string) {
  const loaded = await loadEInvoiceData(id, s.orgId);
  if (!loaded) throw new Error("Rechnung fehlt");
  return loaded.data;
}

const squash = (t: string) => t.replace(/\s+/g, "");
const imageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;

describe("Bezahllink in E-Rechnung und PDF", () => {
  it("BT-20: Skonto-Zeile zuerst, Linksatz am Ende; BT-81 bleibt 58 mit BG-17", async () => {
    const s = await setup();
    const inv = await invoice(s, { skonto: true });
    expect(inv.url).toMatch(/^https:\/\/rechnung\.example\.org\/zahlen\/.{20,}$/);
    const data = await docs(s, inv.id);
    expect(data.payLinkUrl).toBe(inv.url);
    for (const xml of [buildXRechnungUBL(data), buildFacturXCII(data)]) {
      const note = (xml.match(/<cbc:Note>(#SKONTO#[\s\S]*?)<\/cbc:Note>/) ?? xml.match(/<ram:Description>(#SKONTO#[\s\S]*?)<\/ram:Description>/))?.[1] ?? "";
      expect(note.startsWith("#SKONTO#")).toBe(true);
      expect(note.trimEnd().endsWith(`Online bezahlen: ${inv.url}`)).toBe(true);
      expect(note.indexOf("#SKONTO#")).toBeLessThan(note.indexOf("Online bezahlen:"));
    }
    const ubl = buildXRechnungUBL(data);
    expect(ubl).toContain("<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>");
    expect(ubl).toContain("<cac:PayeeFinancialAccount>");
  });

  it("Zahlungsart ONLINE: BT-81 68 ohne BG-17", async () => {
    const s = await setup();
    const inv = await invoice(s, { methodCode: "ONLINE" });
    const data = await docs(s, inv.id);
    const ubl = buildXRechnungUBL(data);
    expect(ubl).toContain("<cbc:PaymentMeansCode>68</cbc:PaymentMeansCode>");
    expect(ubl).not.toContain("<cac:PayeeFinancialAccount>");
    const cii = buildFacturXCII(data);
    expect(cii).toContain("<ram:TypeCode>68</ram:TypeCode>");
    expect(cii).not.toContain("PayeePartyCreditorFinancialAccount");
    expect(ubl).toContain(`Online bezahlen: ${inv.url}`);
  });

  it("englischer Beleg: Pay online", async () => {
    const s = await setup();
    const inv = await invoice(s, { language: "en" });
    const data = await docs(s, inv.id);
    expect(buildXRechnungUBL(data)).toContain(`Pay online: ${inv.url}`);
  });

  it("PDF-Text enthaelt die URL; QR nur ohne GiroCode", async () => {
    const s = await setup();
    const inv = await invoice(s);
    const data = await docs(s, inv.id);
    const theme = testPdfTheme();
    const withLink = await renderInvoicePdf(data, theme);
    expect(squash((await parsePdf(withLink)).text)).toContain(squash(`Online bezahlen: ${inv.url}`));
    // Mit IBAN (GiroCode) erscheint kein zusaetzliches Bild.
    const noLinkGiro = await renderInvoicePdf({ ...data, payLinkUrl: null }, theme);
    expect(imageCount(withLink)).toBe(imageCount(noLinkGiro));
    // Ohne IBAN kein GiroCode -> ein QR-Bild (wie der GiroCode) mehr als ohne Link.
    const noGiroLink = await renderInvoicePdf({ ...data, iban: null }, theme);
    const noGiroNoLink = await renderInvoicePdf({ ...data, iban: null, payLinkUrl: null }, theme);
    expect(imageCount(noGiroNoLink)).toBe(0);
    expect(imageCount(noGiroLink)).toBe(imageCount(noLinkGiro));
    expect(squash((await parsePdf(noGiroNoLink)).text)).not.toContain("Onlinebezahlen");
  });

  it("deaktivierter Link bleibt im neu erzeugten PDF und XML", async () => {
    const s = await setup();
    const inv = await invoice(s);
    await disablePayLink(s.orgId, inv.id, "test");
    const data = await docs(s, inv.id);
    expect(data.payLinkUrl).toBe(inv.url);
    expect(buildXRechnungUBL(data)).toContain(`Online bezahlen: ${inv.url}`);
  });

  it("Testmodus-Link erscheint nirgends auf dem Beleg", async () => {
    const s = await setup({ mode: "TEST" });
    const inv = await invoice(s);
    expect(inv.url).not.toBeNull();
    const data = await docs(s, inv.id);
    expect(data.payLinkUrl).toBeUndefined();
    expect(buildXRechnungUBL(data)).not.toContain("Online bezahlen");
  });

  it("ohne APP_BASE_URL kein Link auf dem Beleg", async () => {
    const s = await setup();
    const inv = await invoice(s);
    delete process.env.APP_BASE_URL;
    try {
      expect((await docs(s, inv.id)).payLinkUrl).toBeUndefined();
    } finally {
      process.env.APP_BASE_URL = BASE;
    }
  });
});

describe("Mail-Platzhalter invoice.paymentLink", () => {
  async function link(s: S, docType: "INVOICE" | "DUNNING", id: string): Promise<unknown> {
    const { ctx } = await buildTemplateContext(s.orgId, docType, id);
    return (ctx.invoice as Record<string, unknown>).paymentLink;
  }

  it("INVOICE und DUNNING mit Link; leer nach Vollzahlung, Storno oder showInMail false", async () => {
    const s = await setup();
    const a = await invoice(s);
    expect(await link(s, "INVOICE", a.id)).toBe(a.url);
    const dunning = await createDunning(a.id, { now: LATER });
    expect(await link(s, "DUNNING", dunning.dunning.id)).toBe(a.url);

    await dbInternal.paymentProviderSettings.update({ where: { orgId: s.orgId }, data: { showInMail: false } });
    expect(await link(s, "INVOICE", a.id)).toBe("");
    expect(await link(s, "DUNNING", dunning.dunning.id)).toBe("");
    await dbInternal.paymentProviderSettings.update({ where: { orgId: s.orgId }, data: { showInMail: true } });

    const paid = await invoice(s);
    await recordPayment(paid.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: LATER });
    expect(await link(s, "INVOICE", paid.id)).toBe("");

    const cancelled = await invoice(s);
    await cancelInvoice(cancelled.id, { orgId: s.orgId, now: LATER });
    expect(await link(s, "INVOICE", cancelled.id)).toBe("");
  });

  it("Testmodus: leer", async () => {
    const s = await setup({ mode: "TEST" });
    const a = await invoice(s);
    expect(await link(s, "INVOICE", a.id)).toBe("");
  });
});

describe("Kundenportal payUrl", () => {
  it("nur bei offener Rechnung mit aktivem Link und eingeschalteter Anzeige", async () => {
    const s = await setup();
    const open = await invoice(s);
    const paid = await invoice(s);
    await recordPayment(paid.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: LATER });
    const off = await invoice(s);
    await disablePayLink(s.orgId, off.id, "test");
    await savePortalSettings(s.orgId, { enabled: true }, "t");
    const { url } = await createPortalLink(s.orgId, s.customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const resolved = await resolvePortalToken(url.slice(`${BASE}/portal/`.length), NOW);
    if (!resolved) throw new Error("Portal-Link fehlt");

    const view = await loadPortalView(resolved, LATER);
    const byId = new Map(view.documents.map((d) => [d.id, d]));
    expect(byId.get(open.id)?.payUrl).toBe(open.url!.slice(BASE.length));
    expect(byId.get(paid.id)?.payUrl).toBeUndefined();
    expect(byId.get(off.id)?.payUrl).toBeUndefined();

    await dbInternal.paymentProviderSettings.update({ where: { orgId: s.orgId }, data: { showInPortal: false } });
    const hidden = await loadPortalView(resolved, LATER);
    expect(hidden.documents.every((d) => d.payUrl === undefined)).toBe(true);
  });

  it("Testkonto: kein Knopf", async () => {
    const s = await setup({ mode: "TEST" });
    await invoice(s);
    await savePortalSettings(s.orgId, { enabled: true }, "t");
    const { url } = await createPortalLink(s.orgId, s.customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const resolved = await resolvePortalToken(url.slice(`${BASE}/portal/`.length), NOW);
    if (!resolved) throw new Error("Portal-Link fehlt");
    const view = await loadPortalView(resolved, LATER);
    expect(view.documents.every((d) => d.payUrl === undefined)).toBe(true);
  });
});
