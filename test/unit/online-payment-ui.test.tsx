import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/einstellungen/online-zahlung/actions", () => ({
  saveOnlinePaymentSettingsAction: async () => ({ ok: true }),
  saveProviderOptionsAction: async () => ({ ok: true }),
  setProviderApiKeyAction: async () => ({ ok: true }),
  setProviderEnabledAction: async () => ({ ok: true }),
  testProviderConnectionAction: async () => ({ ok: true }),
}));
vi.mock("@/app/rechnungen/[id]/pay-link-actions", () => ({
  ensurePayLinkAction: async () => ({ ok: true }),
  disablePayLinkAction: async () => ({ ok: true }),
  refreshPayLinkAction: async () => ({ ok: true }),
}));

import { OnlinePaymentSettingsForm } from "@/components/online-payment/OnlinePaymentSettingsForm";
import { PayLinkSection } from "@/components/online-payment/PayLinkSection";
import { PaymentRuleForm } from "@/components/payment-rules/PaymentRuleForm";
import { emptyRuleFormState } from "@/components/payment-rules/rule-form-model";
import { CustomerForm } from "@/components/forms/CustomerForm";
import { PaymentMethodForm } from "@/components/forms/PaymentMethodForm";
import { SETTINGS_ITEMS, SETTINGS_GROUPS } from "@/lib/nav";
import type { OnlinePaymentSettingsView, ProviderAccountView } from "@/domain/online-payment/settings";
import type { InvoicePayLinkView } from "@/domain/online-payment/views";

const FAKE_KEY = "test_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function account(patch: Partial<ProviderAccountView> = {}): ProviderAccountView {
  return {
    provider: "MOLLIE",
    enabled: false,
    mode: null,
    hasApiKey: false,
    apiKeyLast4: null,
    allowedMethods: null,
    currencies: ["EUR"],
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
    ...patch,
  };
}
function settings(a: ProviderAccountView): OnlinePaymentSettingsView {
  return { defaultProvider: "NONE", showOnPdf: true, showInMail: true, showInPortal: true, accounts: [a] };
}
const form = (a: ProviderAccountView, baseUrlSet = true) => renderToStaticMarkup(<OnlinePaymentSettingsForm initial={settings(a)} baseUrlSet={baseUrlSet} />);

function enabledSwitch(html: string): string {
  const m = /<input[^>]*name="enabled"[^>]*>/.exec(html);
  if (!m) throw new Error("Ein-Schalter nicht gefunden");
  return m[0];
}

describe("Einstellungsformular Online-Zahlung", () => {
  it("zeigt den Schluessel nie im Markup: nur letzte 4 Zeichen, leeres Passwortfeld", () => {
    const html = form(account({ hasApiKey: true, apiKeyLast4: "1234", mode: "LIVE", lastTestOk: true }));
    expect(html).toContain("hinterlegt (…1234)");
    expect(html).toContain("Livemodus");
    expect(html).not.toContain(FAKE_KEY);
    const field = /<input[^>]*name="apiKey"[^>]*>/.exec(html)?.[0] ?? "";
    expect(field).toContain('type="password"');
    expect(field).toContain('autoComplete="new-password"');
    expect(field).toContain('value=""');
  });

  it("Ein-Schalter ist ohne erfolgreiche Pruefung deaktiviert", () => {
    expect(enabledSwitch(form(account({ hasApiKey: true, mode: "TEST", lastTestOk: null })))).toContain("disabled");
    expect(enabledSwitch(form(account({ hasApiKey: true, mode: "TEST", lastTestOk: false })))).toContain("disabled");
    expect(enabledSwitch(form(account({ hasApiKey: false })))).toContain("disabled");
    expect(enabledSwitch(form(account({ hasApiKey: true, mode: "TEST", lastTestOk: true })))).not.toContain("disabled");
  });

  it("Ein-Schalter bleibt ohne APP_BASE_URL gesperrt und warnt", () => {
    const html = form(account({ hasApiKey: true, mode: "LIVE", lastTestOk: true }), false);
    expect(enabledSwitch(html)).toContain("disabled");
    expect(html).toContain("APP_BASE_URL ist nicht gesetzt");
  });

  it("Testmodus wird deutlich gekennzeichnet, Livemodus nicht", () => {
    expect(form(account({ hasApiKey: true, mode: "TEST" }))).toContain("TESTMODUS");
    expect(form(account({ hasApiKey: true, mode: "LIVE" }))).not.toContain("TESTMODUS");
  });

  it("nennt den Schluesselwechsel-Hinweis, die Verbindungsbestaetigung und den Platzhalter", () => {
    const html = form(account({ hasApiKey: true, mode: "LIVE" }));
    expect(html).toContain("Jeder Schlüsselwechsel schaltet die Anbindung aus");
    expect(html).toContain("Baut eine echte Verbindung zu Mollie auf");
    expect(html).toContain("{{invoice.paymentLink}}");
    expect(html).toContain("/einstellungen/vorlagen");
  });
});

const link = (patch: Partial<NonNullable<InvoicePayLinkView["link"]>> | null): InvoicePayLinkView => ({
  invoiceId: "inv1",
  link:
    patch === null
      ? null
      : { id: "l1", invoiceId: "inv1", provider: "MOLLIE", status: "ACTIVE", onDocument: false, disabledAt: null, disabledReason: null, createdAt: new Date("2030-01-01T10:00:00Z"), ...patch },
  url: null,
  attempts: [],
});
const section = (view: InvoicePayLinkView, extra: { cancelled?: boolean; mode?: "TEST" | "LIVE" | null } = {}) =>
  renderToStaticMarkup(<PayLinkSection invoiceId="inv1" initial={view} invoiceCancelled={extra.cancelled ?? false} mode={extra.mode ?? "LIVE"} providerEnabled />);

describe("Bezahllink-Abschnitt", () => {
  it("ohne Link: Anlegen, sonst nichts", () => {
    const html = section(link(null));
    expect(html).toContain("Bezahllink anlegen");
    expect(html).not.toContain("Deaktivieren");
    expect(html).not.toContain("Reaktivieren");
  });

  it("aktiver Link: Deaktivieren, URL-Knoepfe, Status abrufen nur mit offenem Vorgang", () => {
    const base = { ...link({ onDocument: true }), url: "https://rechnung.example.test/zahlen/abc" };
    const html = section(base);
    expect(html).toContain("Deaktivieren");
    expect(html).toContain("Adresse kopieren");
    expect(html).toContain("Im PDF: <span");
    expect(html).toContain("ja");
    expect(html).not.toContain("Status abrufen");
    const withOpen = section({ ...base, attempts: [{ id: "a1", status: "OPEN", amountCents: 11900, currency: "EUR", createdAt: new Date("2030-01-02T10:00:00Z"), expiresAt: null, error: null, overpaidCents: null }] });
    expect(withOpen).toContain("Status abrufen");
    expect(withOpen).toContain("offen");
  });

  it("deaktivierter Link: Reaktivieren; nach Storno weder Reaktivieren noch Anlegen", () => {
    expect(section(link({ status: "DISABLED", disabledReason: "MANUAL" }))).toContain("Reaktivieren");
    const cancelledLink = section(link({ status: "DISABLED", disabledReason: "INVOICE_CANCELLED" }), { cancelled: true });
    expect(cancelledLink).not.toContain("Reaktivieren");
    expect(cancelledLink).toContain("Rechnung storniert");
    expect(section(link(null), { cancelled: true })).not.toContain("Bezahllink anlegen");
  });

  it("Testmodus: Kennzeichnung und Testlink nur intern oeffnebar", () => {
    const html = section({ ...link({}), url: "https://rechnung.example.test/zahlen/abc" }, { mode: "TEST" });
    expect(html).toContain("Testmodus");
    expect(html).toContain("Testlink öffnen (nur intern)");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(section({ ...link({}), url: "https://rechnung.example.test/zahlen/abc" }, { mode: "LIVE" })).not.toContain("Testlink");
  });

  it("zeigt Anlage unklar und Ueberzahlung", () => {
    const view: InvoicePayLinkView = {
      ...link({}),
      attempts: [
        { id: "a1", status: "FAILED", amountCents: 11900, currency: "EUR", createdAt: new Date("2030-01-02T10:00:00Z"), expiresAt: null, error: "Anlage unklar", overpaidCents: null },
        { id: "a2", status: "PAID", amountCents: 15000, currency: "EUR", createdAt: new Date("2030-01-03T10:00:00Z"), expiresAt: null, error: null, overpaidCents: 3100 },
      ],
    };
    const html = section(view);
    expect(html).toContain("Anlage unklar");
    expect(html).toContain("Überzahlung 31,00");
  });
});

describe("Navigation, Regeln, Formulare", () => {
  it("Online-Zahlung steht genau einmal in Einstellungen und Gruppe Firma", () => {
    expect(SETTINGS_ITEMS.filter((i) => i.label === "Online-Zahlung")).toHaveLength(1);
    const firma = SETTINGS_GROUPS.find((g) => g.label === "Firma");
    expect(firma?.keys).toContain("online-zahlung");
    expect(SETTINGS_GROUPS.flatMap((g) => g.keys).filter((k) => k === "online-zahlung")).toHaveLength(1);
  });

  it("Zahlungsregeln bieten den Quellfilter Online (Mollie)", () => {
    const html = renderToStaticMarkup(<PaymentRuleForm tags={[]} templates={[]} initial={{ ...emptyRuleFormState(), allSources: false, sources: ["MOLLIE"] }} />);
    expect(html).toContain("Online (Mollie)");
    expect(html).toMatch(/checked=""\/><span>Online \(Mollie\)/);
  });

  it("Kundenformular und Zahlungsart bieten Wie Voreinstellung / Keine / Mollie", () => {
    const customer = renderToStaticMarkup(<CustomerForm />);
    expect(customer).toContain('name="onlinePaymentProvider"');
    expect(customer).toContain("Wie Voreinstellung");
    expect(customer).toContain("Mollie");
    const pm = renderToStaticMarkup(
      <PaymentMethodForm method={{ id: "m", code: "X", name: "X", description: null, paymentTermsDays: null, invoiceText: null, bankAccountRef: null, bankIban: null, bankBic: null, bankName: null, untdidCode: "ZZZ", onlineProvider: "NONE", isSystem: false, isActive: true, sortOrder: 0 }} />,
    );
    expect(pm).toContain('name="onlineProvider"');
    expect(/<option value="NONE" selected/.test(pm) || pm.includes('value="NONE"')).toBe(true);
  });
});
