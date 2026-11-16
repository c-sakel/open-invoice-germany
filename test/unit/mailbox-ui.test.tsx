import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_ACCEPT_BATCH } from "@/schemas/mailbox";
import { SETTINGS_ITEMS } from "@/lib/nav";
import type { MailboxSettingsClientView } from "@/components/mailbox/mailbox-actions-core";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/einstellungen/postfach/actions", () => ({
  saveMailboxSettingsAction: async () => ({ ok: false, error: "x" }),
  testMailboxConnectionAction: async () => ({ ok: false, error: "x" }),
  setMailboxEnabledAction: async () => ({ ok: false, error: "x" }),
  fetchMailboxNowAction: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/app/eingang/postfach/actions", () => ({
  acceptInboundAction: async () => ({ ok: true, data: { incomingInvoiceId: "i" } }),
  acceptInboundBatchAction: async () => ({ ok: true, data: { entries: [] } }),
  discardInboundAction: async () => ({ ok: true }),
  restoreInboundAction: async () => ({ ok: true }),
}));

const { MailboxSettingsForm } = await import("@/components/mailbox/MailboxSettingsForm");
const { MailboxStatus } = await import("@/components/mailbox/MailboxStatus");
const { InboundMailList } = await import("@/components/mailbox/InboundMailList");
const ui = await import("@/components/mailbox/mailbox-ui");

const BASE: MailboxSettingsClientView = {
  enabled: false,
  host: "imap.example.org",
  port: 993,
  security: "TLS",
  username: "rechnungen@example.org",
  hasPassword: true,
  folder: "INBOX",
  fetchSince: "",
  allowedSenderDomains: [],
  canEnable: false,
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
  lastRunAt: null,
  lastRunOk: null,
  lastRunError: null,
  lastRunFetched: 0,
  inbox: { count: 0, bytes: 0, quotaReached: false },
};

describe("Postfach-Einstellungen", () => {
  it("lässt das Passwortfeld leer und zeigt 'hinterlegt'", () => {
    const html = renderToStaticMarkup(<MailboxSettingsForm initial={BASE} />);
    const input = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('autoComplete="off"');
    expect(input).not.toMatch(/value="[^"]/);
    expect(html).toContain("Passwort hinterlegt.");
  });

  it("schaltet Einschalten ohne erfolgreichen Test ab und mit Test frei", () => {
    const off = renderToStaticMarkup(<MailboxSettingsForm initial={BASE} />);
    expect(/<button[^>]*disabled=""[^>]*>Einschalten<\/button>/.test(off)).toBe(true);
    const on = renderToStaticMarkup(<MailboxSettingsForm initial={{ ...BASE, canEnable: true }} />);
    expect(/<button[^>]*disabled=""[^>]*>Einschalten<\/button>/.test(on)).toBe(false);
  });

  it("zeigt Hinweise zu Absenderfilter, Fälschbarkeit und Nur-Lesen", () => {
    const html = renderToStaticMarkup(<MailboxSettingsForm initial={BASE} />);
    expect(html).toContain("dringend empfohlen");
    expect(html).toContain("fälschbar");
    expect(html).toContain("nie gelöscht oder verschoben");
    expect(html).toContain("OAuth");
  });

  it("OAUTH_REQUIRED und unbekannte Codes liefern feste Texte", () => {
    expect(ui.mailboxErrorText("OAUTH_REQUIRED")).toContain("App-Passwort");
    expect(ui.mailboxErrorText("<script>alert(1)</script>")).toBe(ui.GENERIC_MAILBOX_ERROR);
    const html = renderToStaticMarkup(<MailboxStatus view={{ ...BASE, lastTestAt: "2247-04-01T10:00:00.000Z", lastTestOk: false, lastTestError: "OAUTH_REQUIRED" }} />);
    expect(html).toContain("App-Passwort");
    expect(html).not.toContain("OAUTH_REQUIRED");
  });

  it("Nav-Eintrag und Grenze der Mehrfachauswahl passen zu Schema und Navigation", () => {
    expect(SETTINGS_ITEMS.some((i) => i.key === "postfach" && i.href === "/einstellungen/postfach")).toBe(true);
    expect(ui.UI_MAX_ACCEPT_BATCH).toBe(MAX_ACCEPT_BATCH);
  });
});

const ROW = {
  id: "a1",
  status: "INBOX",
  fileName: "<script>alert(1)</script>.xml",
  size: 2048,
  mailDate: "2247-04-01T08:00:00.000Z",
  fetchedAt: "2247-04-01T09:00:00.000Z",
  senderDomain: "lieferant.example.org",
  subject: "<script>x</script> Rechnung",
  preview: { kind: "XML", isEInvoice: true, number: "R-1", supplierName: "Muster GmbH", grossCents: 11900, currency: "EUR" },
  incomingInvoiceId: null,
  duplicateOfIncomingId: null,
  decidedAt: null,
  discardReason: null,
  purged: false,
  restoreUntil: null,
  skipReason: null,
};

describe("Sichtung", () => {
  it("zeigt Knöpfe je Status und escaped Betreff und Dateiname", () => {
    const inbox = renderToStaticMarkup(<InboundMailList rows={[ROW]} tab="INBOX" />);
    expect(inbox).toContain("Übernehmen");
    expect(inbox).toContain("Verwerfen");
    expect(inbox).toContain("Datei laden");
    expect(inbox).toContain("Ausgewählte übernehmen (0)");
    expect(inbox).not.toContain("<script>");
    expect(inbox).toContain("&lt;script&gt;");
    expect(inbox).toContain("aus der Datei, ungeprüft");
    expect(inbox).toContain("E-Rechnung");

    const discarded = renderToStaticMarkup(<InboundMailList rows={[{ ...ROW, status: "DISCARDED", decidedAt: "2247-04-02T08:00:00.000Z", restoreUntil: "2247-05-02T08:00:00.000Z" }]} tab="DISCARDED" />);
    expect(discarded).toContain("Wiederherstellen");
    expect(discarded).toContain("wiederherstellbar bis");
    expect(discarded).not.toContain(">Übernehmen<");

    const accepted = renderToStaticMarkup(<InboundMailList rows={[{ ...ROW, status: "ACCEPTED", incomingInvoiceId: "inc1" }]} tab="ACCEPTED" />);
    expect(accepted).toContain('href="/eingang/inc1"');
    expect(accepted).not.toContain("Wiederherstellen");
  });

  it("hat keinen Löschknopf und keine HTML-Einbettung", () => {
    const html = renderToStaticMarkup(<InboundMailList rows={[ROW]} tab="INBOX" />);
    expect(html.toLowerCase()).not.toContain("löschen");
    for (const f of ["InboundMailList.tsx", "MailboxSettingsForm.tsx", "MailboxStatus.tsx"]) {
      expect(readFileSync(path.resolve(__dirname, "../../src/components/mailbox", f), "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("Vorschau liest fremde Werte defensiv", () => {
    expect(ui.toPreviewView("x")).toBeNull();
    expect(ui.toPreviewView({ grossCents: 1.5, number: 5 })?.grossCents).toBeNull();
    expect(ui.previewKindLabel({ kind: "OTHER", isEInvoice: false, number: null, supplierName: null, grossCents: null, currency: null })).toBe("Sonstige Rechnung (PDF/Bild)");
    expect(ui.tabStatuses("SKIPPED")).toEqual(["SKIPPED", "DUPLICATE"]);
    expect(ui.parseInboxTab("x")).toBe("INBOX");
  });
});
