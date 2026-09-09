/**
 * Phase 12c, Task 3 — generateMetadata + AGPL-Zeile. Kein RTL im Projekt: die Huellen
 * werden ueber renderToStaticMarkup (react-dom/server, bereits als Next-Abhaengigkeit
 * vorhanden) zu HTML gerendert und im String geprueft. Eigenes Jahr 2080.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dbInternal } from "@/lib/db";
import { saveBrandingSettings, loadBrandingSettings } from "@/domain/settings/branding";
import { loadBrand, DEFAULT_APP_NAME, DEFAULT_BRAND } from "@/domain/settings/brand";
import { SlimShell } from "@/components/shell/SlimShell";

let orgId: string;
vi.mock("@/lib/org", () => ({ getActiveOrg: () => Promise.resolve({ id: orgId }) }));

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Huellen Test GmbH", addressLine1: "Huellenweg 1", postalCode: "10115", city: "Berlin" },
  });
  orgId = org.id;
});

describe("Marke in den Huellen", () => {
  it("ohne Einstellung gilt der Produktname", async () => {
    expect((await loadBrand(orgId)).appName).toBe(DEFAULT_APP_NAME);
  });

  it("generateMetadata nutzt appName als Titel und die Icon-Route", async () => {
    // Ab hier ist die Marke gesetzt — die drei folgenden Faelle bauen darauf auf.
    const current = await loadBrandingSettings(orgId);
    await saveBrandingSettings(orgId, { ...current, appName: "Muster Rechnungen", appShortName: "MR" });
    const { generateMetadata } = await import("@/app/layout");
    const meta = await generateMetadata();
    expect(String(meta.title)).toContain("Muster Rechnungen");
    expect(String(meta.title)).not.toContain("OpenInvoice");
    expect(meta.applicationName).toBe("Muster Rechnungen");
    expect(JSON.stringify(meta.icons)).toContain("/api/branding/icon");
  });

  it("die AGPL-Herkunftszeile bleibt auch bei gesetztem appName sichtbar", () => {
    const html = renderToStaticMarkup(<SlimShell brand={{ appName: "Muster Rechnungen", appShortName: "MR", hasAppLogo: false }}>x</SlimShell>);
    expect(html).toContain("Muster Rechnungen");
    expect(html).toContain("powered by OpenInvoice Germany");
    expect(html).toContain("AGPL-3.0");
  });

  it("ohne Marke zeigt die Huelle die Produktvorgabe", () => {
    const html = renderToStaticMarkup(<SlimShell brand={DEFAULT_BRAND}>x</SlimShell>);
    expect(html).toContain("OpenInvoice Germany");
  });

  // Betreiber-Ruling (2026-09-09): mit hinterlegtem Logo zeigt die Kopfzeile NUR das Bild,
  // kein Name mehr daneben — der Name bleibt am `alt` des Bilds (Barrierefreiheit) und im
  // Browser-Tab-Titel (generateMetadata, siehe Test oben) erhalten.
  it("mit hinterlegtem Logo zeigt die Kopfzeile nur das Bild, der Name bleibt am alt-Text", () => {
    const html = renderToStaticMarkup(<SlimShell brand={{ appName: "Muster Rechnungen", appShortName: "MR", hasAppLogo: true }}>x</SlimShell>);
    expect(html).toContain('alt="Muster Rechnungen"');
    expect(html).not.toContain('<span class="grid'); // Kuerzel-Kachel entfaellt mit Logo
    // Der Name selbst darf nur noch im alt-Attribut stehen, nicht mehr als sichtbarer Text
    // in der Kopfzeile — die AGPL-Fusszeile ist von diesem Ruling unberuehrt (siehe unten).
    const headerHtml = html.slice(0, html.indexOf("</header>"));
    expect(headerHtml.replace(/alt="[^"]*"/g, "")).not.toContain("Muster Rechnungen");
  });

  // Betreiber-Ruling (2026-09-09): Beratungs-Hinweis aus der Fusszeile entfernt (steht
  // bereits in COMPLIANCE.md) — die AGPL-Zeile bleibt exakt bestehen (Lizenzbedingung).
  it("die Fusszeile traegt keinen Beratungs-Hinweis mehr, nur noch die AGPL-Zeile", () => {
    const html = renderToStaticMarkup(<SlimShell brand={DEFAULT_BRAND}>x</SlimShell>);
    expect(html).not.toContain("Steuer-/Rechtsberatung");
    expect(html).not.toContain("COMPLIANCE.md");
    expect(html).toContain("powered by OpenInvoice Germany · AGPL-3.0");
    expect(html).toContain("Quellcode");
  });
});
