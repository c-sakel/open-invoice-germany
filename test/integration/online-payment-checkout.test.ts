/**
 * Online-Zahlung: Bezahlseite und Anlage des Anbieter-Vorgangs (Fake-Transport, kein Netz).
 * Testjahr 2216, je Test eigene Organisation (Belegnummern sind instanzweit eindeutig).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { recordPayment } from "@/domain/invoice/payment";
import { createPayLinkWithinTx, disablePayLink, revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { ATTEMPTS_PER_LINK_PER_DAY, loadPayPage, startCheckout } from "@/domain/online-payment/checkout";
import { PaymentNetworkForbiddenError } from "@/lib/payment/transport";
import { createInvoiceSchema } from "@/schemas";
import { createMollieFake, FAKE_TEST_KEY } from "../helpers/mollie-fake";

const NOW = new Date("2216-03-10T10:00:00.000Z");
const BASE = "https://rechnung.example.org";
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

async function setup(name: string, opts: { accountEnabled?: boolean } = {}) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  const prefix = `OP16-${orgId.slice(-6)}-`;
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2216 } },
    create: { orgId, docType: "INVOICE", year: 2216, currentValue: 0, prefix, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 2216 } }, data: { isActive: false } });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "CREDIT_NOTE", year: 2216 } },
    create: { orgId, docType: "CREDIT_NOTE", year: 2216, currentValue: 0, prefix: `OG16-${orgId.slice(-6)}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix: `OG16-${orgId.slice(-6)}-`, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "CREDIT_NOTE", year: { not: 2216 } }, data: { isActive: false } });
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "MOLLIE" } });
  await dbInternal.paymentProviderAccount.create({
    data: {
      orgId,
      provider: "MOLLIE",
      enabled: true,
      mode: "TEST",
      apiKeyEnc: encryptSecret(FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
      webhookPathId: `wh-${orgId}`,
      lastTestOk: true,
    },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Geheimkunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id,
      issueDate: NOW,
      deliveryDate: new Date("2216-03-05"),
      notes: "GEHEIME-NOTIZ",
      internalReference: "GEHEIME-NOTIZ",
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
  const inv = await finalizeInvoice(d.id, { now: NOW });
  const url = await revealPayLinkUrl(orgId, inv.id, BASE);
  if (!url) throw new Error("Link fehlt");
  // Konto erst nach dem Festschreiben ausschalten (sonst entsteht kein Link).
  if (opts.accountEnabled === false) await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { enabled: false } });
  return { orgId, invoiceId: inv.id, number: inv.number ?? "", token: url.split("/zahlen/")[1]! };
}

/** Fake, das Betrag/Waehrung/Modus der Anfrage spiegelt. */
let objectCounter = 0;
function fakeProvider(opts: { expiresInMs?: number; fail?: number } = {}) {
  const fake = createMollieFake({
    "POST /payments": (req) => {
      if (opts.fail) return { status: opts.fail, text: JSON.stringify({ detail: "GEHEIMER-ANBIETERTEXT" }) };
      const body = JSON.parse(req.body ?? "{}") as { amount: { currency: string; value: string }; metadata: { attemptId: string } };
      objectCounter += 1;
      const id = `tr_Fake${String(objectCounter).padStart(6, "0")}`;
      return {
        status: 201,
        text: JSON.stringify({
          resource: "payment",
          id,
          mode: "test",
          status: "open",
          amount: body.amount,
          metadata: body.metadata,
          expiresAt: new Date(NOW.getTime() + (opts.expiresInMs ?? 60 * 60_000)).toISOString(),
          _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${id}` } },
        }),
      };
    },
  });
  return fake;
}

const attemptsOf = (orgId: string) =>
  dbInternal.paymentProviderAttempt.findMany({
    where: { orgId },
    select: { id: true, status: true, amountCents: true, providerObjectId: true, checkoutUrl: true, error: true, orgId: true },
    orderBy: { createdAt: "asc" },
  });

describe("loadPayPage", () => {
  it("zeigt nur Whitelist-Felder, keinen Kundennamen und keine Notiz; unbekannte Token -> null", async () => {
    const s = await setup("Pay Seite GmbH");
    const state = await loadPayPage(s.token);
    expect(state).toMatchObject({ kind: "PAYABLE", openCents: 11900, currency: "EUR", provider: "MOLLIE", language: "de", invoiceNumber: s.number });
    const text = JSON.stringify(state);
    expect(text).not.toContain("Geheimkunde");
    expect(text).not.toContain("GEHEIME-NOTIZ");
    expect(await loadPayPage("x".repeat(43))).toBeNull();
    expect(await loadPayPage("kurz")).toBeNull();
  });

  it("Testmodus-Konto wird als testMode gemeldet", async () => {
    const s = await setup("Pay Testmodus GmbH");
    expect(await loadPayPage(s.token)).toMatchObject({ kind: "PAYABLE", testMode: true });
    await dbInternal.paymentProviderAccount.updateMany({ where: { orgId: s.orgId }, data: { mode: "LIVE" } });
    expect(await loadPayPage(s.token)).toMatchObject({ kind: "PAYABLE", testMode: false });
  });

  it("Bezahlt, storniert, deaktiviert, Konto aus -> ohne Netz", async () => {
    const paid = await setup("Pay Bezahlt GmbH");
    await recordPayment(paid.invoiceId, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: paid.orgId, now: NOW });
    expect(await loadPayPage(paid.token)).toMatchObject({ kind: "PAID" });
    const cancelled = await setup("Pay Storno GmbH");
    await cancelInvoice(cancelled.invoiceId, { orgId: cancelled.orgId, now: NOW });
    expect(await loadPayPage(cancelled.token)).toMatchObject({ kind: "CANCELLED" });
    const off = await setup("Pay Aus GmbH");
    await disablePayLink(off.orgId, off.invoiceId, "tester");
    expect(await loadPayPage(off.token)).toMatchObject({ kind: "CANCELLED" });
    const noAcc = await setup("Pay Konto GmbH", { accountEnabled: false });
    expect(await loadPayPage(noAcc.token)).toMatchObject({ kind: "UNAVAILABLE" });
  });
});

describe("startCheckout", () => {
  it("erster Klick: genau ein POST, Betrag = Rest, Idempotency-Key = Attempt-Id; zweiter Klick ohne Netz", async () => {
    const s = await setup("Pay Klick GmbH");
    await recordPayment(s.invoiceId, { amountCents: 4000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: NOW });
    const fake = fakeProvider();
    const r1 = await startCheckout(s.token, { transport: fake.transport, now: NOW });
    expect(r1).toMatchObject({ kind: "REDIRECT" });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    const body = JSON.parse(call.body ?? "{}") as { amount: { value: string }; redirectUrl: string; webhookUrl: string; description: string };
    expect(body.amount.value).toBe("79.00");
    expect(body.redirectUrl).toBe(`${BASE}/zahlen/${s.token}?zurueck=1`);
    expect(body.webhookUrl).toBe(`${BASE}/api/public/payments/mollie/wh-${s.orgId}`);
    expect(body.description).toBe(`Rechnung ${s.number}`);
    const [a] = await attemptsOf(s.orgId);
    expect(a).toMatchObject({ status: "OPEN", amountCents: 7900, orgId: s.orgId });
    expect(call.headers["Idempotency-Key"]).toBe(a!.id);
    expect(r1).toEqual({ kind: "REDIRECT", url: a!.checkoutUrl });
    const r2 = await startCheckout(s.token, { transport: fake.transport, now: NOW });
    expect(r2).toEqual(r1);
    expect(fake.calls).toHaveLength(1);
    expect(await attemptsOf(s.orgId)).toHaveLength(1);
  });

  it("Ablauf in 9 min oder geaenderter Rest -> neuer Vorgang", async () => {
    const s = await setup("Pay Neu GmbH");
    const short = fakeProvider({ expiresInMs: 9 * 60_000 });
    await startCheckout(s.token, { transport: short.transport, now: NOW });
    await startCheckout(s.token, { transport: short.transport, now: NOW });
    expect(short.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    const long = fakeProvider();
    await startCheckout(s.token, { transport: long.transport, now: NOW });
    await startCheckout(s.token, { transport: long.transport, now: NOW });
    expect(long.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await recordPayment(s.invoiceId, { amountCents: 1000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: NOW });
    await startCheckout(s.token, { transport: long.transport, now: NOW });
    expect(long.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    const rows = await attemptsOf(s.orgId);
    expect(rows.at(-1)?.amountCents).toBe(10900);
  });

  it("Bezahladresse mit fremdem Host: Attempt FAILED, UNAVAILABLE; gespeicherte fremde Adresse wird nicht weitergegeben", async () => {
    const s = await setup("Pay Host GmbH");
    const evil = createMollieFake({
      "POST /payments": (req) => {
        const body = JSON.parse(req.body ?? "{}") as { amount: unknown; metadata: unknown };
        return {
          status: 201,
          text: JSON.stringify({
            id: "tr_EvilHost001",
            mode: "test",
            status: "open",
            amount: body.amount,
            metadata: body.metadata,
            expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
            _links: { checkout: { href: "https://evil.example.org/pay" } },
          }),
        };
      },
    });
    expect(await startCheckout(s.token, { transport: evil.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect((await attemptsOf(s.orgId)).map((x) => x.status)).toEqual(["FAILED"]);

    const link = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { invoiceId: s.invoiceId }, select: { id: true } });
    await dbInternal.paymentProviderAttempt.create({
      data: {
        orgId: s.orgId, payLinkId: link.id, provider: "MOLLIE", amountCents: 11900, currency: "EUR", status: "OPEN",
        providerObjectId: "tr_EvilDb0001", checkoutUrl: "https://evil.example.org/stored", expiresAt: new Date(NOW.getTime() + 3_600_000), createdAt: NOW,
      },
    });
    const fake = fakeProvider();
    expect(await startCheckout(s.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("neuer Vorgang beendet den alten offenen Vorgang beim Anbieter und fuehrt ihn als CANCELED; Fehler blockieren nicht", async () => {
    const s = await setup("Pay Abbruch GmbH");
    const fake = fakeProvider();
    fake.routes["DELETE /payments/tr_Fake" + String(objectCounter + 1).padStart(6, "0")] = { status: 200, text: "{}" };
    await startCheckout(s.token, { transport: fake.transport, now: NOW });
    await recordPayment(s.invoiceId, { amountCents: 1000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: NOW });
    await startCheckout(s.token, { transport: fake.transport, now: NOW });
    const rows = await attemptsOf(s.orgId);
    expect(rows.map((x) => x.status)).toEqual(["CANCELED", "OPEN"]);
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);

    // Anbieter lehnt den Abbruch ab (z. B. schon bezahlt): bleibt OPEN, neuer Vorgang entsteht trotzdem.
    await recordPayment(s.invoiceId, { amountCents: 1000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: NOW });
    const open = rows[1]!;
    fake.routes[`DELETE /payments/${open.providerObjectId}`] = { status: 422, text: "{}" };
    await startCheckout(s.token, { transport: fake.transport, now: NOW });
    expect((await attemptsOf(s.orgId)).map((x) => x.status)).toEqual(["CANCELED", "OPEN", "OPEN"]);
  });

  it("Anbieterfehler: Attempt FAILED mit festem Text, Seite UNAVAILABLE, kein Anbietertext", async () => {
    const s = await setup("Pay Fehler GmbH");
    for (const status of [422, 500]) {
      const r = await startCheckout(s.token, { transport: fakeProvider({ fail: status }).transport, now: NOW });
      expect(r).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    }
    const rows = await attemptsOf(s.orgId);
    expect(rows.map((x) => x.status)).toEqual(["FAILED", "FAILED"]);
    expect(JSON.stringify(rows)).not.toContain("GEHEIMER-ANBIETERTEXT");
    expect(rows[0]?.error).toBe("Anlage beim Zahlungsanbieter fehlgeschlagen.");
  });

  it("Netzsperre ohne Fake: Attempt FAILED, UNAVAILABLE", async () => {
    const s = await setup("Pay Sperre GmbH");
    await expect(
      (async () => {
        const r = await startCheckout(s.token, { now: NOW });
        expect(r).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
        throw new PaymentNetworkForbiddenError();
      })(),
    ).rejects.toBeInstanceOf(PaymentNetworkForbiddenError);
    expect((await attemptsOf(s.orgId)).map((x) => x.status)).toEqual(["FAILED"]);
  });

  it("CREATING juenger 30 s -> BUSY; 21. Versuch in 24 h -> UNAVAILABLE", async () => {
    const s = await setup("Pay Busy GmbH");
    const link = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { invoiceId: s.invoiceId }, select: { id: true } });
    await dbInternal.paymentProviderAttempt.create({
      data: { orgId: s.orgId, payLinkId: link.id, provider: "MOLLIE", amountCents: 11900, currency: "EUR", status: "CREATING", createdAt: new Date(NOW.getTime() - 5_000) },
    });
    const fake = fakeProvider();
    expect(await startCheckout(s.token, { transport: fake.transport, now: NOW })).toEqual({ kind: "BUSY" });
    expect(fake.calls).toHaveLength(0);

    const l = await setup("Pay Limit GmbH");
    const link2 = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { invoiceId: l.invoiceId }, select: { id: true } });
    for (let i = 0; i < ATTEMPTS_PER_LINK_PER_DAY; i++) {
      await dbInternal.paymentProviderAttempt.create({
        data: { orgId: l.orgId, payLinkId: link2.id, provider: "MOLLIE", amountCents: 11900, currency: "EUR", status: "FAILED", createdAt: new Date(NOW.getTime() - 3_600_000) },
      });
    }
    expect(await startCheckout(l.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("bezahlt/storniert/deaktiviert/Konto aus/unbekannt: kein Netz", async () => {
    const fake = fakeProvider();
    const paid = await setup("Pay K Bezahlt GmbH");
    await recordPayment(paid.invoiceId, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: paid.orgId, now: NOW });
    expect(await startCheckout(paid.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "PAID" } });
    const c = await setup("Pay K Storno GmbH");
    await cancelInvoice(c.invoiceId, { orgId: c.orgId, now: NOW });
    expect(await startCheckout(c.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "CANCELLED" } });
    const d = await setup("Pay K Aus GmbH");
    await disablePayLink(d.orgId, d.invoiceId, "tester");
    expect(await startCheckout(d.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "CANCELLED" } });
    const o = await setup("Pay K Konto GmbH", { accountEnabled: false });
    expect(await startCheckout(o.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect(await startCheckout("y".repeat(43), { transport: fake.transport, now: NOW })).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("Org-Konsistenz: Attempt.orgId = orgId des Links; Link einer fremden Organisation findet die Rechnung nicht", async () => {
    const a = await setup("Pay Org A GmbH");
    const b = await setup("Pay Org B GmbH");
    await startCheckout(a.token, { transport: fakeProvider().transport, now: NOW });
    expect((await attemptsOf(a.orgId))[0]?.orgId).toBe(a.orgId);
    expect(await attemptsOf(b.orgId)).toHaveLength(0);
    // Manipulierter Link: Organisation B, Rechnung von A -> kein Beleg, kein Vorgang.
    await dbInternal.$transaction(async (tx) => {
      await expect(createPayLinkWithinTx(tx, { orgId: b.orgId, invoiceId: a.invoiceId, provider: "MOLLIE", onDocument: false, actor: "t", now: NOW })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
