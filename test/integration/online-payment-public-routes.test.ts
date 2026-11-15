/**
 * Oeffentliche Bezahlseite und Route `bezahlen`: Same-Origin, Methoden, Rate-Limit, Weiterleitung. Testjahr 2217.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.current }));
const transport = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/payment/transport", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/payment/transport")>();
  return {
    ...orig,
    defaultPaymentTransport: () => async (req: { url: string; body?: string }) => {
      transport.calls.push(req.url);
      const body = JSON.parse(req.body ?? "{}") as { amount: unknown; metadata: unknown };
      return {
        status: 201,
        text: JSON.stringify({
          resource: "payment",
          id: "tr_RouteTest01",
          mode: "test",
          status: "open",
          amount: body.amount,
          metadata: body.metadata,
          expiresAt: "2217-03-10T12:00:00.000Z",
          _links: { checkout: { href: "https://www.mollie.com/checkout/select-method/RouteTest01" } },
        }),
      };
    },
  };
});

import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { hashToken } from "@/domain/quote-share/token";
import { resetRateLimits } from "@/lib/rate-limit";
import { createInvoiceSchema } from "@/schemas";
import PayPage from "@/app/zahlen/[token]/page";
import * as bezahlen from "@/app/zahlen/[token]/bezahlen/route";
import { FAKE_TEST_KEY } from "../helpers/mollie-fake";

const NOW = new Date("2217-03-10T10:00:00.000Z");
const BASE = "https://rechnung.example.org";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;
let token = "";

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = BASE;
  const org = await dbInternal.organization.create({
    data: { legalName: "Pay Route GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  const prefix = `OP17-${orgId.slice(-6)}-`;
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2217 } },
    create: { orgId, docType: "INVOICE", year: 2217, currentValue: 0, prefix, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 2217 } }, data: { isActive: false } });
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "MOLLIE" } });
  await dbInternal.paymentProviderAccount.create({
    data: { orgId, provider: "MOLLIE", enabled: true, mode: "TEST", apiKeyEnc: encryptSecret(FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE), webhookPathId: `wh-${orgId}`, lastTestOk: true },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id,
      issueDate: NOW,
      deliveryDate: new Date("2217-03-05"),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
  const inv = await finalizeInvoice(d.id, { now: NOW });
  token = (await revealPayLinkUrl(orgId, inv.id, BASE))!.split("/zahlen/")[1]!;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});
beforeEach(() => {
  resetRateLimits();
  transport.calls.length = 0;
  hdrs.current = new Headers();
});

function post(t: string, headers: Record<string, string> = {}): Promise<Response> {
  return bezahlen.POST(
    new Request(`http://localhost/zahlen/${t}/bezahlen`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.20", ...headers } }),
    { params: Promise.resolve({ token: t }) },
  );
}

describe("Route bezahlen", () => {
  it("exportiert nur POST (GET -> 405 durch Next)", () => {
    expect("GET" in bezahlen).toBe(false);
    expect("POST" in bezahlen).toBe(true);
  });

  it("fremder Ursprung -> 403 ohne Netz", async () => {
    const res = await post(token, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(transport.calls).toHaveLength(0);
  });

  it("gueltiger Klick -> 303 auf die Anbieter-URL mit Sicherheitsheadern", async () => {
    const res = await post(token, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://www.mollie.com/checkout/select-method/RouteTest01");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(transport.calls).toHaveLength(1);
  });

  it("BUSY und Anbieterfehler: Weiterleitung auf die Seite mit festem Hinweis", async () => {
    const link = await dbInternal.invoicePayLink.findFirstOrThrow({ where: { tokenHash: hashToken(token) }, select: { id: true, orgId: true } });
    await dbInternal.paymentProviderAttempt.updateMany({ where: { payLinkId: link.id, status: "OPEN" }, data: { status: "CANCELED" } });
    const busy = await dbInternal.paymentProviderAttempt.create({
      data: { orgId: link.orgId, payLinkId: link.id, provider: "MOLLIE", amountCents: 11900, currency: "EUR", status: "CREATING", createdAt: new Date() },
      select: { id: true },
    });
    const res = await post(token, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/zahlen/${token}?hinweis=busy`);
    await dbInternal.paymentProviderAttempt.update({ where: { id: busy.id }, data: { status: "FAILED", error: "x" } });
  });

  it("ungueltiges Token -> 404; 6. Aufruf je Token -> 429", async () => {
    expect((await post("z".repeat(43))).status).toBe(404);
    expect((await post("kurz")).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await post(token)).status).toBe(303);
    expect((await post(token)).status).toBe(429);
  });
});

describe("Seite", () => {
  it("GET der Seite loest keinen Netzaufruf aus und zeigt Betrag und Knopf", async () => {
    const html = renderToStaticMarkup(await PayPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("119,00");
    expect(html).toContain(`action="/zahlen/${token}/bezahlen"`);
    expect(html).not.toContain("Kunde AG");
    expect(transport.calls).toHaveLength(0);
  });

  it("Testmodus-Kennzeichnung; ?hinweis=unavailable ersetzt den Knopf; ?hinweis=busy zeigt Wartehinweis", async () => {
    const page = async (sp: { hinweis?: string }) => renderToStaticMarkup(await PayPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(sp) }));
    const normal = await page({});
    expect(normal).toContain("Testmodus");
    expect(normal).toContain("bezahlen");
    const unavailable = await page({ hinweis: "unavailable" });
    expect(unavailable).toContain("nicht verfügbar");
    expect(unavailable).not.toContain(`action="/zahlen/${token}/bezahlen"`);
    const busy = await page({ hinweis: "busy" });
    expect(busy).toContain("vorbereitet");
    expect(busy).toContain(`action="/zahlen/${token}/bezahlen"`);
    expect(await page({ hinweis: "<script>" })).not.toContain("<script>");
  });

  it("Rueckkehr (?zurueck=1) zeigt den Hinweis; unbekanntes Token -> notFound", async () => {
    const html = renderToStaticMarkup(await PayPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ zurueck: "1" }) }));
    expect(html).toContain("verarbeitet");
    await expect(PayPage({ params: Promise.resolve({ token: "q".repeat(43) }), searchParams: Promise.resolve({}) })).rejects.toThrow();
  });
});
