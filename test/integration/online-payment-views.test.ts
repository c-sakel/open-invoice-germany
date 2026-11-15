/**
 * Server-Actions der Oberflaeche fuer Online-Zahlung (Einstellungen und Bezahllink). Fake-Transport, kein Netz.
 * Kein festgeschriebener Beleg: nur Einstellungen und ein Entwurf.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));
const fake = vi.hoisted(() => ({ handler: null as null | ((req: { method: string; url: string }) => { status: number; text: string }) }));
vi.mock("@/lib/payment/transport", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/payment/transport")>();
  return {
    ...orig,
    defaultPaymentTransport: () => async (req: { method: string; url: string }) => {
      if (!fake.handler) throw new Error("kein Fake gesetzt");
      return fake.handler(req);
    },
  };
});

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { createInvoiceSchema } from "@/schemas";
import {
  saveOnlinePaymentSettingsAction,
  saveProviderOptionsAction,
  setProviderApiKeyAction,
  setProviderEnabledAction,
  testProviderConnectionAction,
} from "@/app/einstellungen/online-zahlung/actions";
import { ensurePayLinkAction, disablePayLinkAction, refreshPayLinkAction } from "@/app/rechnungen/[id]/pay-link-actions";
import { mollieFixture, FAKE_TEST_KEY } from "../helpers/mollie-fake";

const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;
let orgId: string;
let draftId: string;
let foreignOrgId: string;

async function newOrg(name: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  return org.id;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = "https://rechnung.example.test";
  orgId = await newOrg("Online UI GmbH");
  foreignOrgId = await newOrg("Fremd UI GmbH");
  orgStore.id = orgId;
  const customer = await dbInternal.customer.create({ data: { orgId, name: "UI Kunde", addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg" } });
  draftId = (
    await createDraftInvoice(
      orgId,
      createInvoiceSchema.parse({
        customerId: customer.id,
        issueDate: new Date("2219-03-10"),
        deliveryDate: new Date("2219-03-05"),
        lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
      }),
      { now: new Date("2219-03-10T10:00:00.000Z") },
    )
  ).id;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});

beforeEach(() => {
  fake.handler = null;
});

describe("Einstellungen (Server-Actions)", () => {
  it("ungueltiger Schluessel -> deutscher Fehler ohne den Wert; nichts gespeichert", async () => {
    const res = await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: "test_zu-kurz-und-ungueltig!" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Der Schlüssel hat kein gültiges Format.");
    expect(res.error).not.toContain("zu-kurz");
    expect(await dbInternal.paymentProviderAccount.count({ where: { orgId, apiKeyEnc: { not: null } } })).toBe(0);
  });

  it("Schluessel setzen liefert keinen Klartext, speichert verschluesselt und schaltet aus", async () => {
    const res = await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: FAKE_TEST_KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res)).not.toContain(FAKE_TEST_KEY);
    expect(res.settings.accounts[0]).toMatchObject({ hasApiKey: true, mode: "TEST", enabled: false, lastTestOk: null, apiKeyLast4: FAKE_TEST_KEY.slice(-4) });
    const row = await dbInternal.paymentProviderAccount.findFirst({ where: { orgId }, select: { apiKeyEnc: true } });
    expect(row?.apiKeyEnc).toBeTruthy();
    expect(row?.apiKeyEnc).not.toContain(FAKE_TEST_KEY);
  });

  it("Einschalten ohne erfolgreichen Test wird abgelehnt (deutscher Text)", async () => {
    const res = await setProviderEnabledAction({ provider: "MOLLIE", enabled: true });
    expect(res).toEqual({ ok: false, error: "Zum Einschalten ist ein erfolgreicher Verbindungstest noetig." });
  });

  it("Verbindungstest mit Fake: Erfolg erlaubt Einschalten; Schluesselwechsel schaltet wieder aus und verwirft den Test", async () => {
    fake.handler = () => ({ status: 200, text: mollieFixture("methods") });
    const t = await testProviderConnectionAction({ provider: "MOLLIE" });
    expect(t.ok).toBe(true);
    expect(JSON.stringify(t)).not.toContain(FAKE_TEST_KEY);
    const on = await setProviderEnabledAction({ provider: "MOLLIE", enabled: true });
    expect(on.ok && on.settings.accounts[0].enabled).toBe(true);

    const swapped = await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: "test_NEUaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(swapped.ok && swapped.settings.accounts[0]).toMatchObject({ enabled: false, lastTestOk: null });
    expect(await setProviderEnabledAction({ provider: "MOLLIE", enabled: true })).toMatchObject({ ok: false });
  });

  it("fehlgeschlagener Test -> fester Text, Einschalten bleibt gesperrt", async () => {
    fake.handler = () => ({ status: 401, text: mollieFixture("error-401") });
    const t = await testProviderConnectionAction({ provider: "MOLLIE" });
    expect(t.ok).toBe(false);
    expect(JSON.stringify(t)).not.toContain("Missing authentication");
    expect(await setProviderEnabledAction({ provider: "MOLLIE", enabled: true })).toMatchObject({ ok: false });
  });

  it("Eingaben werden mit Zod geprueft: unbekannter Anbieter, Zusatzfelder, falsche Waehrung", async () => {
    expect(await setProviderEnabledAction({ provider: "STRIPE", enabled: true })).toMatchObject({ ok: false });
    expect(await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: 5 })).toMatchObject({ ok: false });
    expect(await saveOnlinePaymentSettingsAction({ defaultProvider: "MOLLIE", apiKey: "x" })).toMatchObject({ ok: false });
    expect(await saveProviderOptionsAction({ provider: "MOLLIE", options: { currencies: ["XXX"] } })).toMatchObject({ ok: false });
    const ok = await saveOnlinePaymentSettingsAction({ showInPortal: false });
    expect(ok.ok && ok.settings.showInPortal).toBe(false);
    const opts = await saveProviderOptionsAction({ provider: "MOLLIE", options: { allowedMethods: ["ideal"], currencies: ["EUR", "CHF"] } });
    expect(opts.ok && opts.settings.accounts[0]).toMatchObject({ allowedMethods: ["ideal"], currencies: ["EUR", "CHF"] });
  });

  it("Schluessel entfernen schaltet aus und leert den Zugang", async () => {
    const res = await setProviderApiKeyAction({ provider: "MOLLIE", apiKey: null });
    expect(res.ok && res.settings.accounts[0]).toMatchObject({ hasApiKey: false, mode: null, enabled: false });
  });
});

describe("Bezahllink (Server-Actions)", () => {
  it("Entwurf -> deutscher Fehlertext", async () => {
    const res = await ensurePayLinkAction(draftId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/[a-zäöü]/);
    expect(res.error).toBe("Fuer diese Rechnung ist kein Bezahllink moeglich.");
  });

  it("fremde Org und unbekannte Rechnung -> nicht gefunden", async () => {
    orgStore.id = foreignOrgId;
    for (const action of [ensurePayLinkAction, refreshPayLinkAction]) {
      expect(await action(draftId)).toEqual({ ok: false, error: "Rechnung nicht gefunden." });
    }
    // Deaktivieren sucht den Link der Organisation: fuer fremde Rechnungen gibt es keinen.
    expect(await disablePayLinkAction(draftId)).toEqual({ ok: false, error: "Kein Bezahllink vorhanden." });
    orgStore.id = orgId;
    expect(await ensurePayLinkAction("gibt-es-nicht")).toEqual({ ok: false, error: "Rechnung nicht gefunden." });
  });

  it("ungueltige Id -> Eingabefehler", async () => {
    expect(await ensurePayLinkAction(42)).toEqual({ ok: false, error: "Ungültige Eingabe." });
  });
});
