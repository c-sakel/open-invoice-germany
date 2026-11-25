import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { NewRecurringForm, type RecurringInitialValues } from "@/components/NewRecurringForm";
import { CollectiveCard } from "@/app/abos/[id]/_parts/CollectiveCard";
import { CollectiveOriginCard } from "@/app/rechnungen/[id]/_parts/CollectiveOriginCard";

const initial = (over: Partial<RecurringInitialValues> = {}): RecurringInitialValues => ({
  title: "Wartung",
  interval: "MONTHLY",
  intervalCount: 1,
  startDate: "2209-03-01",
  endDate: "",
  maxRuns: "",
  paymentTermsDays: 14,
  autoFinalize: false,
  autoSend: false,
  emailTemplateId: "",
  showPeriodText: true,
  notes: "",
  currency: "EUR",
  billingTiming: "ARREARS",
  lines: [],
  ...over,
});

const form = (init?: RecurringInitialValues) =>
  renderToStaticMarkup(
    <NewRecurringForm products={[]} taxRates={[19, 7, 0]} mode={init ? "edit" : "create"} recurringId="r1" customerName="Kunde" initial={init} />,
  );

describe("Abo-Formular: Kunde", () => {
  it("rendert eine Such-Auswahl mit Pflichtfeld, keine Kundenliste", () => {
    const html = form();
    expect(html).not.toMatch(/Kunde<\/span><select/);
    expect(html).not.toContain('value="c1"');
    expect(html).toMatch(/<input[^>]*aria-label="Kunde"[^>]*/);
    expect(html).toMatch(/<input[^>]*role="combobox"[^>]*required|<input[^>]*required[^>]*role="combobox"/);
  });
});

describe("Abo-Formular: Abrechnungsart-Initialwert", () => {
  it("Bearbeiten zeigt die gespeicherte Abrechnungsart", () => {
    expect(form(initial({ billingTiming: "ADVANCE" }))).toMatch(/<input[^>]*value="ADVANCE"[^>]*checked=""|<input[^>]*checked=""[^>]*value="ADVANCE"/);
    expect(form(initial({ billingTiming: "ARREARS" }))).toMatch(/<input[^>]*value="ARREARS"[^>]*checked=""|<input[^>]*checked=""[^>]*value="ARREARS"/);
  });
});

describe("Abo-Formular: Sammelrechnung", () => {
  it("zeigt den Schalter, aber ohne Schalter kein Ueberschriftsfeld", () => {
    const html = form();
    expect(html).toContain("Sammelrechnung");
    expect(html).not.toContain("Blocküberschrift auf der Rechnung");
  });

  it("mit Schalter: Pflichtfeld mit Startwert und Hinweis zu Gruppierung und Folgetag", () => {
    const html = form(initial({ collectiveBilling: true, invoiceHeading: "Wartung &amp; Pflege" }));
    expect(html).toContain("Blocküberschrift auf der Rechnung");
    expect(html).toMatch(/<input[^>]*required[^>]*value="Wartung &amp;amp; Pflege"|<input[^>]*value="Wartung &amp;amp; Pflege"[^>]*required/);
    expect(html).toContain("Tag nach dem Stichtag");
    expect(html).toContain("gleicher Währung");
  });

  it("Bearbeiten ohne Schalter zeigt kein Feld", () => {
    expect(form(initial({ collectiveBilling: false }))).not.toContain("Blocküberschrift auf der Rechnung");
  });
});

describe("Karten", () => {
  it("Partnerkarte: gemeinsam und Grund der Trennung in Klartext", () => {
    const html = renderToStaticMarkup(
      <CollectiveCard
        heading="Wartung"
        partners={[
          { id: "p1", title: "Hosting", state: "together", reasons: [] },
          { id: "p2", title: "Dollar", state: "split", reasons: ["currency", "paymentTermsDays"] },
        ]}
      />,
    );
    expect(html).toContain("gemeinsam");
    expect(html).toContain("Währung weicht ab");
    expect(html).toContain("Zahlungsziel weicht ab");
    expect(html).toContain('href="/abos/p2"');
  });

  it("Partnerkarte ohne Partner nennt die normale Rechnung", () => {
    expect(renderToStaticMarkup(<CollectiveCard heading="Wartung" partners={[]} />)).toContain("normale Rechnung");
  });

  it("Herkunftskarte zeigt Positionsbereiche je Block", () => {
    const html = renderToStaticMarkup(
      <CollectiveOriginCard
        blocks={[
          { recurringId: "r1", title: "Wartung", from: 1, to: 3 },
          { recurringId: "r2", title: "Hosting", from: 4, to: 4 },
        ]}
      />,
    );
    expect(html).toContain("Pos. 1–3");
    expect(html).toContain("Pos. 4:");
    expect(html).toContain("Hosting");
  });
});
