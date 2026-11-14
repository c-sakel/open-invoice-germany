import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/kunden/[id]/portal-actions", () => ({
  createPortalLinkAction: async () => ({ ok: true }),
  revokePortalLinkAction: async () => ({ ok: true }),
  revealPortalUrlAction: async () => ({ ok: true, url: "x" }),
  sendPortalLinkAction: async () => ({ ok: true, to: "x" }),
}));
vi.mock("@/app/einstellungen/kundenportal/actions", () => ({
  savePortalSettingsAction: async () => ({ ok: true }),
}));

import { PortalSettingsForm } from "@/components/settings/PortalSettingsForm";
import { PortalLinkCard, type PortalLinkCardProps } from "@/components/customers/PortalLinkCard";
import { DEFAULT_PORTAL_SETTINGS } from "@/domain/portal/settings";
import { SETTINGS_ITEMS, SETTINGS_GROUPS } from "@/lib/nav";

const base: PortalLinkCardProps = {
  customerId: "c1",
  portalEnabled: true,
  customerArchived: false,
  link: null,
  events: [],
  defaultRecipient: "kunde@example.org",
};

describe("Portal-Einstellungsformular", () => {
  it("zeigt Schalter, Linkdauer, Mailtext und Platzhalter", () => {
    const html = renderToStaticMarkup(<PortalSettingsForm initial={{ ...DEFAULT_PORTAL_SETTINGS, mailSubject: "Betreff X" }} />);
    expect(html).toContain("Kundenportal einschalten");
    expect(html).toContain("Gültigkeit neuer Links");
    expect(html).toContain('value="365"');
    expect(html).toContain("Betreff X");
    expect(html).toContain("{{portal.url}}");
    expect(html).toContain("{{portal.validUntil}}");
    expect(html).toContain("ausgeschaltet");
  });
});

describe("Portal-Karte", () => {
  it("ohne Link: Hinweis und Erzeugen-Knopf", () => {
    const html = renderToStaticMarkup(<PortalLinkCard {...base} />);
    expect(html).toContain("Kein Link vorhanden");
    expect(html).toContain("Link erzeugen");
    expect(html).toContain("Noch keine Abrufe");
  });

  it("aktiver Link: Ablaufdatum, Aktionen, Mailfeld vorbelegt, keine URL", () => {
    const html = renderToStaticMarkup(
      <PortalLinkCard
        {...base}
        link={{ active: true, createdAt: "2195-03-01T10:00:00.000Z", expiresAt: "2196-03-01T10:00:00.000Z", revokedAt: null, lastViewedAt: null, viewCount: 0 }}
      />,
    );
    expect(html).toContain("Aktiv");
    expect(html).toContain("01.03.2196");
    expect(html).toContain("Link kopieren");
    expect(html).toContain("Neu erzeugen");
    expect(html).toContain("Widerrufen");
    expect(html).toContain("alte Link wird ungültig");
    expect(html).toContain('value="kunde@example.org"');
    expect(html).not.toContain("/portal/");
  });

  it("widerrufener Link", () => {
    const html = renderToStaticMarkup(
      <PortalLinkCard
        {...base}
        link={{ active: false, createdAt: "2195-03-01T10:00:00.000Z", expiresAt: "2196-03-01T10:00:00.000Z", revokedAt: "2195-04-01T10:00:00.000Z", lastViewedAt: null, viewCount: 0 }}
      />,
    );
    expect(html).toContain("Widerrufen</span> am 01.04.2195");
    expect(html).toContain("Link erzeugen");
    expect(html).not.toContain("Per Mail senden");
  });

  it("Portal ausgeschaltet: Hinweis mit Link zu den Einstellungen", () => {
    const html = renderToStaticMarkup(<PortalLinkCard {...base} portalEnabled={false} />);
    expect(html).toContain("Das Kundenportal ist ausgeschaltet");
    expect(html).toContain('href="/einstellungen/kundenportal"');
    expect(html).not.toContain("Link erzeugen");
  });

  it("zeigt die letzten Abrufe mit Art und Belegnummer", () => {
    const html = renderToStaticMarkup(
      <PortalLinkCard
        {...base}
        events={[
          { id: "e1", at: "2195-03-02T10:00:00.000Z", kind: "DOWNLOAD", fileKind: "UBL", docNumber: "RE-2195-0001" },
          { id: "e2", at: "2195-03-02T09:00:00.000Z", kind: "VIEW", fileKind: null, docNumber: null },
        ]}
      />,
    );
    expect(html).toContain("Download E-Rechnung (XML)");
    expect(html).toContain("RE-2195-0001");
    expect(html).toContain("Portal aufgerufen");
  });

  it("archivierter Kunde ohne aktiven Link: kein Erzeugen", () => {
    const html = renderToStaticMarkup(<PortalLinkCard {...base} customerArchived />);
    expect(html).not.toContain(">Link erzeugen<");
    expect(html).toContain("archivierte Kunden");
  });
});

describe("Navigation", () => {
  it("Kundenportal steht nach Postversand und in der Gruppe Kommunikation", () => {
    const keys = SETTINGS_ITEMS.map((i) => i.key);
    expect(keys.indexOf("kundenportal")).toBe(keys.indexOf("post") + 1);
    expect(SETTINGS_GROUPS.find((g) => g.label === "Kommunikation")?.keys).toContain("kundenportal");
  });
});
