import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/einstellungen/datev/actions", () => ({
  saveDatevSettingsAction: async () => ({ ok: true }),
  applyDatevTemplateAction: async () => ({ ok: true, added: 0, replaced: 0, keptEdited: [], withoutSuggestion: [] }),
  saveDatevMappingAction: async () => ({ ok: true }),
  confirmDatevMappingAction: async () => ({ ok: true }),
  previewDatevExportAction: async () => ({ ok: false, error: "x" }),
  runDatevExportAction: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/app/actions/masterdata", () => ({ saveCustomer: async () => ({ ok: true }) }));

import { DatevConfirmBanner } from "@/components/datev/DatevConfirmBanner";
import { DatevExportPanel, DatevLateBanner, DatevPreview } from "@/components/datev/DatevExportPanel";
import { DatevHistory } from "@/components/datev/DatevHistory";
import { DatevConfirmForm, DatevMappingTable, TemplateResult, type DatevConfirmInfo } from "@/components/datev/DatevMappingTable";
import { DatevSettingsForm, PAYMENTS_WARNING, type DatevSettingsFormValues } from "@/components/datev/DatevSettingsForm";
import { CustomerForm, type CustomerFormData } from "@/components/forms/CustomerForm";
import { buildMappingRows, describeMappingKey, type PreviewDto } from "@/domain/export/datev/ui";

const info: DatevConfirmInfo = { confirmed: false, stale: false, confirmedAt: null, confirmedNote: null, consultantNumber: 123456, clientNumber: 12345, chart: "SKR03" };

const settings: DatevSettingsFormValues = {
  consultantNumber: 123456, clientNumber: 12345, accountLength: 4, chartOfAccounts: "SKR03", fiscalYearStartMonth: 1, debtorMode: "PERSONAL",
  collectiveDebtorAccount: null, debtorRangeStart: 10000, bankAccount: 1200, cashAccount: 1000, dictationCode: null,
  exportPayments: false, exportDebtors: true, useGeneralReversal: true, lockBatch: false,
};

describe("DATEV-Banner", () => {
  it("ohne Bestätigung: Export gesperrt, Vorlagen nur Vorschläge", () => {
    const html = renderToStaticMarkup(<DatevConfirmBanner confirmed={false} stale={false} confirmedAt={null} />);
    expect(html).toContain("Export gesperrt: Kontenzuordnung mit dem Steuerberater abstimmen und bestätigen.");
    expect(html).toContain("nur Vorschläge");
  });
  it("erloschene Bestätigung wird benannt", () => {
    const html = renderToStaticMarkup(<DatevConfirmBanner confirmed={false} stale confirmedAt="2096-03-10T10:00:00.000Z" />);
    expect(html).toContain("Bestätigung erloschen");
    expect(html).toContain("10.03.2096");
  });
  it("bestätigt: kein Banner", () => {
    expect(renderToStaticMarkup(<DatevConfirmBanner confirmed stale={false} confirmedAt={null} />)).toBe("");
  });
});

describe("Exportbereich", () => {
  it("ohne Bestätigung sind Vorschau und Export deaktiviert", () => {
    const html = renderToStaticMarkup(<DatevExportPanel confirmed={false} defaultMonth="2096-03" pendingLate={[]} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Export erstellen<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Vorschau<\/button>/);
    expect(html).toContain("Export gesperrt, bis die Kontenzuordnung bestätigt ist.");
  });
  it("Nachtragsbanner nennt die Anzahl", () => {
    const html = renderToStaticMarkup(<DatevLateBanner pendingLate={[{ month: "2096-03", count: 2, amountCents: 100 }, { month: "2096-04", count: 1, amountCents: 5 }]} />);
    expect(html).toContain("3 Nachträge in bereits exportierten Monaten");
  });
  it("kein Nachtragsbanner ohne Nachträge", () => {
    expect(renderToStaticMarkup(<DatevLateBanner pendingLate={[]} />)).toBe("");
  });
});

describe("Vorschau", () => {
  const preview: PreviewDto = {
    mode: "PERIOD", months: ["2096-03"], lineCount: 4, itemCount: 3, manualCount: 1, debtorCount: 1, newDebtors: 1,
    issues: [{ code: "MISSING_MAPPING", message: "Kein Konto zugeordnet fuer REVENUE REGULAR|S|19", key: "REVENUE REGULAR|S|19", documents: ["RE-1"] }],
    manual: [{ reference: "RE-7", month: "2096-03", reason: "Fremdwaehrungszahlung", amountCents: 12345, currency: "USD" }],
    repeats: [{ month: "2096-03", exportId: "e1", createdAt: "2096-04-01T00:00:00.000Z", identical: false }],
  };
  it("zeigt Zähler, Issues mit Belegnummern, MANUAL-Liste und Wiederholung", () => {
    const html = renderToStaticMarkup(<DatevPreview preview={preview} />);
    expect(html).toContain("3 Posten, 4 Buchungszeilen, 1 manuell nachzubuchen");
    expect(html).toContain("Kein Konto zugeordnet fuer REVENUE REGULAR|S|19");
    expect(html).toContain("RE-1");
    expect(html).toContain("Manuell nachzubuchen (1)");
    expect(html).toContain("RE-7");
    expect(html).toContain("Fremdwaehrungszahlung");
    expect(html).toContain("Inhalt weicht vom früheren Export ab");
  });
  it("identische Wiederholung", () => {
    const html = renderToStaticMarkup(<DatevPreview preview={{ ...preview, issues: [], manual: [], repeats: [{ ...preview.repeats[0], identical: true }] }} />);
    expect(html).toContain("identisch");
    expect(html).not.toContain("Export nicht möglich");
  });
});

describe("Zuordnungstabelle", () => {
  it("markiert fehlende Schlüssel für vorhandene Belege rot", () => {
    const rows = buildMappingRows({
      chart: "SKR03",
      mapping: [{ kind: "REVENUE", key: "REGULAR|S|19", account: 8400, buKey: null }],
      used: [
        { kind: "REVENUE", key: "REGULAR|S|19", count: 5 },
        { kind: "REVENUE", key: "REGULAR|Z|0", count: 2 },
        { kind: "MONEY", key: "PROVIDER:MOLLIE", count: 1 },
      ],
    });
    expect(rows.find((r) => r.key === "REGULAR|S|19")?.missing).toBe(false);
    expect(rows.find((r) => r.key === "REGULAR|Z|0")?.missing).toBe(true);
    expect(rows.find((r) => r.key === "PROVIDER:MOLLIE")?.missing).toBe(true);
    // Vorlagenzeile ohne Beleg ist keine Lücke.
    expect(rows.find((r) => r.key === "REGULAR|S|7")?.missing).toBe(false);
    const html = renderToStaticMarkup(<DatevMappingTable rows={rows} info={info} />);
    expect(html).toContain('data-missing="true"');
    expect(html).toContain("Konto fehlt, Export gesperrt");
    expect(html).toContain("Druckansicht");
    expect(html).toContain('id="datev-print-area"');
  });
  it("Schlüssel werden lesbar beschrieben", () => {
    expect(describeMappingKey("REVENUE", "REGULAR|S|19")).toBe("Regelbesteuerung, Kategorie S, 19 %");
    expect(describeMappingKey("MONEY", "PROVIDER:STRIPE")).toBe("Geldtransit Zahlungsanbieter STRIPE");
  });
  it("Vorlagenergebnis zeigt geänderte und vorschlaglose Zeilen", () => {
    const html = renderToStaticMarkup(<TemplateResult result={{ added: 3, replaced: 1, keptEdited: ["Bankkonto"], withoutSuggestion: ["REVENUE REGULAR|Z|0"] }} />);
    expect(html).toContain("3 Zeile(n) ergänzt");
    expect(html).toContain("Unverändert geblieben (von Hand geändert): Bankkonto");
    expect(html).toContain("Ohne Vorschlag");
  });
  it("Bestätigungsformular mit Steuerberater-Hinweis", () => {
    const html = renderToStaticMarkup(<DatevConfirmForm info={info} hasMissing />);
    expect(html).toContain("Vorher mit dem Steuerberater abstimmen.");
    expect(html).toContain("Konten und Steuerschlüssel mit dem Steuerberater abgestimmt");
    expect(html).toContain("Abgestimmt mit / am");
    expect(html).toContain("Der Export bleibt gesperrt");
  });
});

describe("Einstellungen", () => {
  it("Zahlungsexport trägt den Doppelbuchungs-Hinweis, Festschreiben Standard aus", () => {
    const html = renderToStaticMarkup(<DatevSettingsForm initial={settings} />);
    expect(html).toContain(PAYMENTS_WARNING.slice(0, 40));
    expect(html).toContain("doppelte Geldbuchungen");
    expect(html).toContain("DATEV schreibt sonst nach dem Import fest");
    expect(html).toContain("123456");
  });
});

describe("Protokoll", () => {
  it("zeigt Hash voll im Titel, Kennzeichnung und Download", () => {
    const sha = "a".repeat(64);
    const html = renderToStaticMarkup(
      <DatevHistory rows={[
        { id: "x1", mode: "SUPPLEMENT", fromMonth: "2096-03", toMonth: "2096-03", repeat: false, lineCount: 4, manualCount: 1, sha256: sha, createdAt: "2096-04-01T10:00:00.000Z" },
        { id: "x2", mode: "PERIOD", fromMonth: "2096-01", toMonth: "2096-02", repeat: true, lineCount: 9, manualCount: 0, sha256: "b".repeat(64), createdAt: "2096-04-02T10:00:00.000Z" },
      ]} />,
    );
    expect(html).toContain(`title="${sha}"`);
    expect(html).toContain("Nachtrag");
    expect(html).toContain("Wiederholung");
    expect(html).toContain('href="/api/datev/x1/file"');
    expect(html).toContain("01/2096 bis 02/2096");
  });
  it("leeres Protokoll", () => {
    expect(renderToStaticMarkup(<DatevHistory rows={[]} />)).toContain("Noch kein Export erstellt.");
  });
});

describe("Kundenformular", () => {
  const customer: CustomerFormData = {
    id: "c1", type: "BUSINESS", name: "Kunde", contactName: null, addressLine1: "Weg 1", addressLine2: null, postalCode: "12345", city: "Ort", countryCode: "DE",
    email: null, phone: null, vatId: null, leitwegId: null, peppolId: null, peppolScheme: null, legalRegistrationId: null, customerNumber: null,
    defaultPaymentTermsDays: null, defaultPaymentMethodId: null, notes: null,
  };
  it("Debitorennummer nach Export gesperrt mit Hinweis", () => {
    const html = renderToStaticMarkup(<CustomerForm customer={{ ...customer, datevAccount: 10001, datevAccountLocked: true }} />);
    expect(html).toContain("DATEV-Debitorennummer");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*name="datevAccount"/);
    expect(html).toContain("Nach dem ersten DATEV-Export gesperrt");
    expect(html).toContain('value="10001"');
  });
  it("Vor dem Export editierbar", () => {
    const html = renderToStaticMarkup(<CustomerForm customer={{ ...customer, datevAccount: null, datevAccountLocked: false }} />);
    expect(html).toContain('name="datevAccount"');
    expect(html).not.toMatch(/<input[^>]*disabled=""[^>]*name="datevAccount"/);
  });
  it("Neuanlage ohne Feld", () => {
    expect(renderToStaticMarkup(<CustomerForm />)).not.toContain("datevAccount");
  });
});
