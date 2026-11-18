import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_GROUPS, SETTINGS_ITEMS } from "@/lib/nav";
import type { BankConnectionClientView } from "@/components/bank-fetch/bank-fetch-core";
import type { PublicChallenge } from "@/domain/bank-fetch/setup";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/einstellungen/kontoabruf/actions", () => ({
  saveBankFetchSettingsAction: async () => ({ ok: false, error: "x" }),
  createBankConnectionAction: async () => ({ ok: false, error: "x" }),
  updateBankConnectionAction: async () => ({ ok: false, error: "x" }),
  archiveBankConnectionAction: async () => ({ ok: false, error: "x" }),
  storeBankPinAction: async () => ({ ok: false, error: "x" }),
  setBankAutoAction: async () => ({ ok: false, error: "x" }),
  selectBankAccountsAction: async () => ({ ok: false, error: "x" }),
  connectBankAction: async () => ({ ok: false, error: "x" }),
  continueBankSetupAction: async () => ({ ok: false, error: "x" }),
  cancelBankSetupAction: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/app/bankabgleich/fetch-actions", () => ({
  startBankFetchAction: async () => ({ ok: false, error: "x" }),
  continueBankFetchAction: async () => ({ ok: false, error: "x" }),
  cancelBankFetchAction: async () => ({ ok: false, error: "x" }),
}));
const settings = vi.hoisted(() => ({ configured: false }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: "org-1" }) }));
vi.mock("@/domain/bank-fetch/settings", () => ({
  loadBankFetchSettings: async () => ({ productIdConfigured: settings.configured, autoHour: 6, firstFetchDays: 30 }),
}));
vi.mock("@/domain/bank-fetch/status", () => ({ listBankFetchRuns: async () => ({ items: [], total: 0, limit: 50, offset: 0, nextCursor: null }) }));
vi.mock("@/components/bank-fetch/bank-fetch-core", async (orig) => ({
  ...(await orig<typeof import("@/components/bank-fetch/bank-fetch-core")>()),
  loadClientConnections: async () => [],
}));

const ui = await import("@/components/bank-fetch/bank-fetch-ui");
const { ProductIdForm } = await import("@/components/bank-fetch/ProductIdForm");
const { StoredPinForm } = await import("@/components/bank-fetch/StoredPinForm");
const { ScaDialog } = await import("@/components/bank-fetch/ScaDialog");
const { AutoFetchControl, BankConnectionCard } = await import("@/components/bank-fetch/BankConnectionCard");
const { TanMethodChooser, AccountPicker } = await import("@/components/bank-fetch/BankSetupWizard");
const { BankFetchRunTable, FetchRunSummaryList } = await import("@/components/bank-fetch/BankFetchRunTable");
const { BankFetchSection } = await import("@/components/bank-fetch/BankFetchSection");
const { default: SettingsPage } = await import("@/app/einstellungen/kontoabruf/page");

const CONN: BankConnectionClientView = {
  id: "c1",
  label: "Geschaeftskonto",
  bankCode: "37040044",
  url: "https://fints.example.org/fints",
  userId: "kunde4711",
  customerId: null,
  pinMode: "PER_FETCH",
  hasPin: false,
  tanMethodId: null,
  autoEnabled: false,
  state: "NEW",
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastScaAt: null,
  scaRenewBy: null,
  lastErrorCode: null,
  accounts: [
    { id: "a1", ibanMasked: "DE89 **** 3000", currency: "EUR", productName: "Girokonto", camtSupported: true, selected: true, lastFetchedTo: null },
    { id: "a2", ibanMasked: "DE02 **** 2051", currency: "EUR", productName: "Sparkonto", camtSupported: false, selected: false, lastFetchedTo: null },
  ],
};
const CHALLENGE: PublicChallenge = { decoupled: true, text: "Bitte freigeben", imageDataUrl: null, imageOmitted: false, waitMs: 2000 };
const noop = () => {};

describe("Produkt-ID", () => {
  it("ohne ID: Hinweis mit Link, Feld leer", () => {
    const html = renderToStaticMarkup(<ProductIdForm configured={false} />);
    expect(html).toContain("Die Registrierung ist bei der Deutschen Kreditwirtschaft kostenlos");
    expect(html).toContain('href="https://www.fints.org"');
    expect(html).not.toMatch(/name="productId"[^>]*value="[^"]/);
    expect(html).not.toContain("hinterlegt\"");
  });
  it("mit ID: nur 'hinterlegt', nie der Wert", () => {
    const html = renderToStaticMarkup(<ProductIdForm configured />);
    expect(html).toContain('placeholder="hinterlegt"');
    expect(html).not.toMatch(/name="productId"[^>]*value="[^"]/);
    expect(html).toContain("Entfernen");
  });
  it("Einstellungsseite ohne ID zeigt nur den Hinweis, mit ID Bankzugaenge und Protokoll", async () => {
    settings.configured = false;
    const without = renderToStaticMarkup(await SettingsPage());
    expect(without).toContain("Produkt-ID");
    expect(without).not.toContain("Bankzugang hinzufügen");
    expect(without).not.toContain("Protokoll der letzten Abrufe");
    settings.configured = true;
    const withId = renderToStaticMarkup(await SettingsPage());
    expect(withId).toContain("Bankzugang hinzufügen");
    expect(withId).toContain("Protokoll der letzten Abrufe");
    expect(withId).toContain("PIN je Abruf (Standard)");
  });
});

describe("PIN-Felder", () => {
  it("leer, type=password, autocomplete=off; 'PIN speichern' ohne Haken deaktiviert", () => {
    const html = renderToStaticMarkup(<StoredPinForm connectionId="c1" state="NEW" lastErrorCode={null} onSaved={noop} onError={noop} />);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*/);
    expect(html).toMatch(/autoComplete|autocomplete="off"/i);
    expect(html).not.toMatch(/name="pin"[^>]*value="[^"]/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>PIN speichern<\/button>/);
    expect(html).toContain("Zahlungen in Ihrem Online-Banking");
  });
  it("abgelehnter Zugang verlangt die ausdrueckliche Bestaetigung", () => {
    const rejected = renderToStaticMarkup(<StoredPinForm connectionId="c1" state="PIN_REJECTED" lastErrorCode="PIN_REJECTED" onSaved={noop} onError={noop} />);
    expect(rejected).toContain(ui.UNLOCK_CONFIRM_TEXT);
    const locked = renderToStaticMarkup(<StoredPinForm connectionId="c1" state="PIN_REJECTED" lastErrorCode="ACCESS_LOCKED" onSaved={noop} onError={noop} />);
    expect(locked).toContain(ui.BANK_UNLOCK_CONFIRM_TEXT);
  });
  it("Karte: Standard PIN je Abruf, kein Passwort im Markup", () => {
    const html = renderToStaticMarkup(<BankConnectionCard connection={CONN} />);
    expect(html).toContain("PIN je Abruf (Standard)");
    expect(html).not.toMatch(/value="[^"]*Pin/);
  });
});

describe("Automatischer Abruf", () => {
  it("Schalter nur bei gespeicherter PIN und Zustand Bereit", () => {
    const html = (c: Partial<BankConnectionClientView>) => renderToStaticMarkup(<AutoFetchControl connection={{ ...CONN, ...c }} onToggle={noop} />);
    expect(html({ pinMode: "STORED", hasPin: true, state: "READY" })).toContain("Täglich automatisch abrufen");
    expect(html({ pinMode: "STORED", hasPin: true, state: "READY", scaRenewBy: "2257-01-01T00:00:00.000Z" })).toContain("spätestens erneuern bis");
    for (const c of [{ pinMode: "PER_FETCH" as const }, { pinMode: "STORED" as const, hasPin: true, state: "NEW" }, { pinMode: "STORED" as const, hasPin: false, state: "READY" }]) {
      expect(html(c)).not.toContain('type="checkbox"');
    }
  });
});

describe("Freigabe", () => {
  it("Freigabe in der App: Hinweis und Challenge-Text, kein TAN-Feld", () => {
    const html = renderToStaticMarkup(<ScaDialog challenge={CHALLENGE} busy={false} onContinue={noop} onCancel={noop} />);
    expect(html).toContain("Bitte in Ihrer Banking-App freigeben.");
    expect(html).toContain("Bitte freigeben");
    expect(html).not.toContain('type="password"');
    expect(html).toContain("Abbrechen");
  });
  it("TAN-Eingabe als Passwortfeld ohne Autovervollstaendigung", () => {
    const html = renderToStaticMarkup(<ScaDialog challenge={{ ...CHALLENGE, decoupled: false, waitMs: 0 }} busy={false} onContinue={noop} onCancel={noop} />);
    expect(html).toMatch(/type="password"/);
    expect(html).toContain("TAN senden");
  });
  it("Bild nur als Daten-URL einer Rastergrafik", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(renderToStaticMarkup(<ScaDialog challenge={{ ...CHALLENGE, imageDataUrl: png }} busy={false} onContinue={noop} onCancel={noop} />)).toContain(`src="${png}"`);
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(renderToStaticMarkup(<ScaDialog challenge={{ ...CHALLENGE, imageDataUrl: svg }} busy={false} onContinue={noop} onCancel={noop} />)).not.toContain("<img");
    expect(ui.isSafeImageDataUrl("javascript:alert(1)")).toBe(false);
    expect(ui.isSafeImageDataUrl("data:image/gif;base64,R0lGODlh")).toBe(true);
  });
  it("Challenge-Text mit Skript wird maskiert", () => {
    const html = renderToStaticMarkup(<ScaDialog challenge={{ ...CHALLENGE, text: "<script>alert(1)</script>" }} busy={false} onContinue={noop} onCancel={noop} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("optische chipTAN ist ausgegraut, Freigabe in der App steht zuerst", () => {
    const html = renderToStaticMarkup(
      <TanMethodChooser
        selected={null}
        onSelect={noop}
        methods={[
          { id: 910, name: "chipTAN optisch", decoupled: false, media: [] },
          { id: 944, name: "BankPass App", decoupled: true, media: [] },
        ]}
      />,
    );
    expect(html.indexOf("BankPass App")).toBeLessThan(html.indexOf("chipTAN optisch"));
    expect(html).toMatch(/disabled=""[^>]*\/?><span>chipTAN optisch/);
    expect(html).toContain(ui.OPTICAL_CHIPTAN_HINT);
  });
  it("Konten ohne CAMT sind nicht wählbar", () => {
    const html = renderToStaticMarkup(<AccountPicker accounts={CONN.accounts} selected={new Set(["a1"])} onToggle={noop} />);
    expect(html).toContain("Bank bietet keinen CAMT-Abruf");
    expect(html).toContain("DE02 **** 2051");
  });
});

describe("Texte, Warnungen, Protokoll", () => {
  it("feste Texte je Code, unbekannte Codes nie im Wortlaut", () => {
    expect(ui.bankFetchErrorText("PIN_REJECTED")).toBe(
      "Die Bank hat die Anmeldung abgelehnt. Automatischer Abruf ist aus. Bitte PIN prüfen — nach mehreren Fehlversuchen sperrt die Bank den Zugang.",
    );
    expect(ui.bankFetchErrorText("FREMD_TEXT_DER_BANK")).toBe(ui.GENERIC_BANK_FETCH_ERROR);
    expect(ui.bankFetchErrorText(null)).toBe(ui.GENERIC_BANK_FETCH_ERROR);
    for (const code of ["AUTH_UNCLEAR", "SCA_REQUIRED", "ACCESS_LOCKED", "SCA_TIMEOUT", "NO_CAMT", "ACCOUNT_MISMATCH"]) {
      expect(ui.bankFetchErrorText(code)).not.toBe(ui.GENERIC_BANK_FETCH_ERROR);
    }
  });
  it("Warnungen je Zustand und Lücke im Zeitraum", () => {
    expect(ui.connectionWarnings({ state: "PIN_REJECTED", lastErrorCode: "PIN_REJECTED", autoEnabled: false, hasPin: false })[0]).toContain("sperrt die Bank den Zugang");
    expect(ui.connectionWarnings({ state: "SCA_REQUIRED", lastErrorCode: null, autoEnabled: true, hasPin: true })[0]).toContain("Freigabe");
    expect(ui.connectionWarnings({ state: "READY", lastErrorCode: null, autoEnabled: true, hasPin: true })).toEqual([]);
    expect(ui.gapWarning({ from: "2256-01-01T00:00:00.000Z", to: "2256-03-01T00:00:00.000Z", gapBefore: "2255-10-01T00:00:00.000Z" })).toContain("gekürzt");
    expect(ui.gapWarning({ from: "2256-01-01T00:00:00.000Z", to: "2256-03-01T00:00:00.000Z", gapBefore: null })).toBeNull();
  });
  it("Protokoll: Konto maskiert, Ergebnis als fester Text, Link zum Bankabgleich", () => {
    const html = renderToStaticMarkup(
      <BankFetchRunTable
        runs={[{ id: "r1", startedAt: "2256-03-01T10:00:00.000Z", trigger: "AUTO", ibanMasked: "DE89 **** 3000", from: "2256-02-01T00:00:00.000Z", to: "2256-03-01T00:00:00.000Z", result: "SCA_REQUIRED", importedCount: 0, duplicateCount: 0, importId: null }]}
      />,
    );
    expect(html).toContain("DE89 **** 3000");
    expect(html).toContain(ui.bankFetchErrorText("SCA_REQUIRED"));
    const list = renderToStaticMarkup(
      <FetchRunSummaryList runs={[{ runId: "r", accountId: "a1", iban: "DE89 **** 3000", result: "OK", bankCodes: [], from: "2256-02-01T00:00:00.000Z", to: "2256-03-01T00:00:00.000Z", gapBefore: null, documents: 1, bytes: 10, importId: "i1", importedCount: 2, duplicateCount: 1, scaUsed: false }]} />,
    );
    expect(list).toContain("2 neu, 1 Dubletten");
    expect(list).toContain('href="/bankabgleich"');
  });
  it("Bankabgleich: Bereich nur bei mindestens einem Bankzugang", () => {
    expect(renderToStaticMarkup(<BankFetchSection connections={[]} />)).toBe("");
    const html = renderToStaticMarkup(<BankFetchSection connections={[{ ...CONN, state: "READY", lastSuccessAt: "2256-03-01T10:00:00.000Z" }]} />);
    expect(html).toContain("Konten abrufen");
    expect(html).toContain("Bereit");
  });
});

describe("kein Löschen, Navigation", () => {
  it("'Entfernen' archiviert mit Bestätigungstext; kein Löschknopf", () => {
    const html = renderToStaticMarkup(<BankConnectionCard connection={CONN} />);
    expect(html).toContain("Entfernen");
    expect(html).not.toMatch(/Löschen/);
    expect(ui.ARCHIVE_CONFIRM_TEXT).toContain("archiviert");
  });
  it("kein Quelltext der Oberfläche nennt Löschen von Bankzugängen", () => {
    const dir = path.resolve(__dirname, "../../src/components/bank-fetch");
    for (const f of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/delete[A-Z]\w*Connection|Löschen/);
    }
  });
  it("Einstellungen: Eintrag Kontoabruf in genau einer Gruppe", () => {
    expect(SETTINGS_ITEMS.filter((i) => i.key === "kontoabruf")).toHaveLength(1);
    expect(SETTINGS_GROUPS.filter((g) => g.keys.includes("kontoabruf"))).toHaveLength(1);
  });
  it("Produkt-ID-Hinweis nennt fints.org, nie eine echte ID", () => {
    expect(ui.PRODUCT_ID_NOTICE).toContain("fints.org");
    expect(readFileSync(path.resolve(__dirname, "../../src/components/bank-fetch/bank-fetch-ui.ts"), "utf8")).not.toMatch(/TESTPRODUKT/);
  });
});
