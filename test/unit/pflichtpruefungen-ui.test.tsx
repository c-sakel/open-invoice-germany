/**
 * Oberflaeche der Belegpruefungen: Entwurfs-Rundlauf des Verzugshinweises, Kennzeichen Kleinbetrag,
 * Ausstellfrist im Editor und in der Belegansicht, Einstellungsformular (Betrag, Jahre, Marker).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }), usePathname: () => "/" }));

import { renderToStaticMarkup } from "react-dom/server";
import { draftFromInvoice, emptyDraft, toInvoicePayload, draftReducer, type DraftState } from "@/lib/editor/draft";
import { draftIssueDeadline, draftSmallAmount, deDateKey } from "@/lib/editor/checks";
import { computeDraftTotals, type DraftTotals } from "@/lib/editor/totals";
import { TotalsBlock } from "@/components/editor/blocks/TotalsBlock";
import { MetaBlock } from "@/components/editor/blocks/MetaBlock";
import { MoreOptions } from "@/components/editor/blocks/MoreOptions";
import { DocumentSettingsForm } from "@/components/forms/DocumentSettingsForm";
import { parseKuExternalRows } from "@/lib/ku-external-input";
import { buildInvoiceViewModel, consumerNoticeOf, type InvoiceDetail } from "@/app/rechnungen/[id]/_parts/invoice-view-model";
import { InvoiceStatusCard } from "@/app/rechnungen/[id]/_parts/InvoiceStatusCard";
import { documentSettingsInputSchema } from "@/schemas/quote-share";
import { KU_NOTICE } from "@/schemas/small-business";
import { de } from "@/lib/i18n/doc/de";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/[  ]/g, " ");

function totalsFor(grossCents: number): DraftTotals {
  return { lineNetCents: grossCents, allowanceCents: 0, chargeCents: 0, netCents: grossCents, taxRows: [], taxCents: 0, grossCents, subtotals: [], error: null };
}

describe("Verzugshinweis im Entwurf", () => {
  const base = { id: "i1", customerId: "c1", taxScheme: "REGULAR", lines: [] } as never;
  it("Rundlauf null/true/false: draftFromInvoice -> toInvoicePayload", () => {
    for (const v of [null, true, false] as const) {
      const d = draftFromInvoice({ ...(base as object), consumerDefaultNotice: v } as never);
      expect(d.consumerDefaultNotice).toBe(v);
      expect((toInvoicePayload(d, true) as { consumerDefaultNotice: boolean | null }).consumerDefaultNotice).toBe(v);
    }
    expect(draftFromInvoice(base).consumerDefaultNotice).toBeNull();
  });

  it("Neuanlage: null wird weggelassen, true/false werden gesendet", () => {
    expect(toInvoicePayload(emptyDraft("INVOICE"), false).consumerDefaultNotice).toBeUndefined();
    expect(toInvoicePayload({ ...emptyDraft("INVOICE"), consumerDefaultNotice: false }, false).consumerDefaultNotice).toBe(false);
  });

  it("Auswahl Automatisch / Immer / Nie im Editor", () => {
    const d = emptyDraft("INVOICE");
    const html = renderToStaticMarkup(<MoreOptions mode="INVOICE" isEdit={false} draft={d} dispatch={() => undefined} layouts={[]} />);
    expect(text(html)).toContain("Verzugshinweis für Verbraucher");
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="yes"');
    expect(html).toContain('value="no"');
    const yes = renderToStaticMarkup(<MoreOptions mode="INVOICE" isEdit={false} draft={{ ...d, consumerDefaultNotice: true }} dispatch={() => undefined} layouts={[]} />);
    expect(yes).toMatch(/<option value="yes" selected/);
    const quote = renderToStaticMarkup(<MoreOptions mode="DOCUMENT" isEdit={false} draft={{ ...d, mode: "DOCUMENT" }} dispatch={() => undefined} layouts={[]} />);
    expect(quote).not.toContain("Verzugshinweis");
  });

  it("set-Aktion setzt den Wert und markiert den Entwurf als geaendert", () => {
    const d = draftReducer(emptyDraft("INVOICE"), { type: "set", field: "consumerDefaultNotice", value: true });
    expect(d.consumerDefaultNotice).toBe(true);
    expect(d.dirty).toBe(true);
  });
});

describe("Kleinbetrag im Editor", () => {
  const inv: Pick<DraftState, "mode" | "type" | "taxScheme"> = { mode: "INVOICE", type: "INVOICE", taxScheme: "REGULAR" };
  it("250,00 EUR ja, 250,01 EUR nein", () => {
    expect(draftSmallAmount(inv, 25_000, "EUR", null)).toBe(true);
    expect(draftSmallAmount(inv, 25_001, "EUR", null)).toBe(false);
    expect(draftSmallAmount(inv, 0, "EUR", null)).toBe(false);
  });
  it("Fremdwaehrung, Gutschrift, ig. Schema und Fernverkauf an EU-Privatkunden nicht", () => {
    expect(draftSmallAmount(inv, 10_000, "USD", null)).toBe(false);
    expect(draftSmallAmount({ ...inv, type: "CREDIT_NOTE" }, 10_000, "EUR", null)).toBe(false);
    expect(draftSmallAmount({ ...inv, taxScheme: "IG_LIEFERUNG" }, 10_000, "EUR", null)).toBe(false);
    expect(draftSmallAmount(inv, 10_000, "EUR", { countryCode: "AT", vatId: null })).toBe(false);
    expect(draftSmallAmount(inv, 10_000, "EUR", { countryCode: "AT", vatId: "ATU12345678" })).toBe(true);
    expect(draftSmallAmount(inv, 10_000, "EUR", { countryCode: "DE", vatId: null })).toBe(true);
  });
  it("Kennzeichen erscheint in der Summenanzeige nur auf Anforderung", () => {
    const d = emptyDraft("INVOICE");
    const on = text(renderToStaticMarkup(<TotalsBlock totals={totalsFor(25_000)} draft={d} smallAmount />));
    expect(on).toContain("Kleinbetragsrechnung (§ 33 UStDV)");
    expect(on).toContain("250,00");
    expect(text(renderToStaticMarkup(<TotalsBlock totals={totalsFor(25_001)} draft={d} />))).not.toContain("Kleinbetragsrechnung");
  });
  it("Summen aus dem Entwurf liefern den Bruttowert fuer die Pruefung", () => {
    let d = emptyDraft("INVOICE");
    d = draftReducer(d, { type: "setLine", key: d.lines[0]!.key, patch: { description: "Teil", quantity: "1", price: "210,08", taxRate: 19 } });
    expect(computeDraftTotals(d).grossCents).toBe(25_000);
  });
});

describe("Ausstellfrist im Editor", () => {
  const ig = { ...emptyDraft("INVOICE"), taxScheme: "IG_LIEFERUNG" as const, deliveryDateFollowsIssue: false };
  it("nur bei ig. Schema mit Leistungsdatum", () => {
    expect(draftIssueDeadline({ ...ig, deliveryDate: "2232-03-03", issueDate: "2232-04-01" }, "2232-04-01")).toEqual({ key: "2232-04-15", missed: false });
    expect(draftIssueDeadline({ ...ig, deliveryDate: "" }, "2232-04-01")).toBeNull();
    expect(draftIssueDeadline({ ...ig, taxScheme: "REGULAR", deliveryDate: "2232-03-03" }, "2232-04-01")).toBeNull();
    expect(draftIssueDeadline({ ...ig, taxScheme: "IG_LEISTUNG", deliveryDate: "2232-03-03" }, "2232-04-01")?.key).toBe("2232-04-15");
  });
  it("Leistungsende hat Vorrang; Frist 15. des Folgemonats auch ueber den Jahreswechsel", () => {
    expect(draftIssueDeadline({ ...ig, deliveryDate: "2232-11-03", deliveryEnd: "2232-12-20", issueDate: "2232-12-21" }, "2232-12-21")?.key).toBe("2233-01-15");
  });
  it("rot nach Ablauf: Belegdatum oder heute nach dem Fristtag", () => {
    expect(draftIssueDeadline({ ...ig, deliveryDate: "2232-03-03", issueDate: "2232-04-16" }, "2232-04-01")?.missed).toBe(true);
    expect(draftIssueDeadline({ ...ig, deliveryDate: "2232-03-03", issueDate: "2232-04-15" }, "2232-04-15")?.missed).toBe(false);
    expect(draftIssueDeadline({ ...ig, deliveryDate: "2232-03-03", issueDate: "" }, "2232-04-16")?.missed).toBe(true);
  });
  it("Leistungsdatum folgt dem Belegdatum", () => {
    const follow = { ...ig, deliveryDateFollowsIssue: true, deliveryDate: "", issueDate: "2232-05-10" };
    expect(draftIssueDeadline(follow, "2232-05-10")?.key).toBe("2232-06-15");
  });
  it("Fristzeile im Metablock, rot mit Hinweis nach Ablauf", () => {
    const render = (d: DraftState) => renderToStaticMarkup(<MetaBlock mode="INVOICE" isEdit draft={d} dispatch={() => undefined} />);
    const ok = render({ ...ig, deliveryDate: "2999-03-03", issueDate: "2999-04-01" });
    expect(text(ok)).toContain("Ausstellfrist: bis 15.04.2999 (§ 14a Abs. 1, 3 UStG)");
    expect(ok).not.toContain("text-stamp");
    const late = render({ ...ig, deliveryDate: "2020-03-03", issueDate: "2020-05-01" });
    expect(text(late)).toContain("Ausstellfrist: bis 15.04.2020");
    expect(text(late)).toContain("überschritten");
    expect(late).toContain("text-stamp");
    expect(text(render({ ...ig, taxScheme: "REGULAR", deliveryDate: "2020-03-03" }))).not.toContain("Ausstellfrist");
  });
  it("deDateKey", () => expect(deDateKey("2232-04-05")).toBe("05.04.2232"));
});

const customer = {
  id: "c1", name: "Kunde", contactName: null, addressLine1: "Weg 1", addressLine2: null, postalCode: "10115", city: "Berlin", countryCode: "DE",
  vatId: null, taxNumber: null, email: null, type: "BUSINESS",
};

function invoiceOf(over: Record<string, unknown>): InvoiceDetail {
  return {
    id: "i1", status: "FINALIZED", type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    grossTotalCents: 11_900, netTotalCents: 10_000, taxTotalCents: 1_900, netTotalEurCents: null, taxTotalEurCents: null,
    issueDate: new Date("2232-05-10T10:00:00Z"), dueDate: new Date("2232-05-24T00:00:00Z"), deliveryDate: new Date("2232-03-03T00:00:00Z"), deliveryEnd: null,
    finalizedAt: null, buyerSnapshotJson: null, taxBreakdownJson: "[]", payments: [], finalDeductions: [], dunningState: null,
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    skonto1Permille: null, skonto1Days: null, skonto2Permille: null, skonto2Days: null, paymentMethodSnapshotJson: null, paymentMethod: null,
    paidAmountCents: 0, payableCents: null, consumerDefaultNotice: null, xmlFormat: null, customer, ...over,
  } as unknown as InvoiceDetail;
}

function card(inv: InvoiceDetail): string {
  const vm = buildInvoiceViewModel(inv);
  return text(
    renderToStaticMarkup(
      <InvoiceStatusCard
        invoice={inv}
        openCents={vm.openCents}
        isOverdue={false}
        paymentMethodName={null}
        hasSkonto={false}
        showPaymentBlock={false}
        showPaymentList={false}
        canPay={false}
        paymentMethods={[]}
        defaultPaymentMethod="TRANSFER"
        lastSentAt={null}
        tags={[]}
        tagOptions={[]}
        archive={null}
        smallAmount={vm.smallAmount}
        issueDeadlineKey={vm.issueDeadlineKey}
        issueDeadlineMissed={vm.issueDeadlineMissed}
        consumerNotice={vm.consumerNotice}
      />,
    ),
  );
}

describe("Belegansicht", () => {
  it("Kennzeichen Kleinbetrag bei 119,00 EUR, nicht bei 250,01 EUR", () => {
    expect(card(invoiceOf({}))).toContain("Kleinbetragsrechnung§ 33 UStDV (bis 250,00 €)");
    expect(card(invoiceOf({ grossTotalCents: 25_001 }))).not.toContain("Kleinbetragsrechnung");
    expect(buildInvoiceViewModel(invoiceOf({ grossTotalCents: 25_000 })).smallAmount).toBe(true);
  });

  it("Ausstellfrist bei ig. Lieferung, nach Ablauf mit Hinweis", () => {
    const vm = buildInvoiceViewModel(invoiceOf({ taxScheme: "IG_LIEFERUNG", status: "DRAFT", issueDate: new Date("2232-04-10T10:00:00Z") }));
    expect(vm.issueDeadlineKey).toBe("2232-04-15");
    expect(vm.issueDeadlineMissed).toBe(false);
    const draftLate = buildInvoiceViewModel(invoiceOf({ taxScheme: "IG_LIEFERUNG", status: "DRAFT", issueDate: new Date("2232-05-10T10:00:00Z") }));
    expect(draftLate.issueDeadlineMissed).toBe(true);
    // Entwurf: wird fruehestens heute festgeschrieben -> Fristtag in der Vergangenheit gilt als verpasst.
    const draftPast = buildInvoiceViewModel(invoiceOf({ taxScheme: "IG_LIEFERUNG", status: "DRAFT", deliveryDate: new Date("2020-03-03T00:00:00Z"), issueDate: new Date("2020-04-10T10:00:00Z") }));
    expect(draftPast.issueDeadlineMissed).toBe(true);
    const late = card(invoiceOf({ taxScheme: "IG_LIEFERUNG", status: "FINALIZED", issueDate: new Date("2232-05-10T10:00:00Z") }));
    expect(late).toContain("Ausstellfristbis 15.04.2232 (§ 14a UStG) — überschritten");
    const inTime = card(invoiceOf({ taxScheme: "IG_LIEFERUNG", status: "FINALIZED", issueDate: new Date("2232-04-15T10:00:00Z") }));
    expect(inTime).toContain("bis 15.04.2232 (§ 14a UStG)");
    expect(inTime).not.toContain("überschritten");
    expect(buildInvoiceViewModel(invoiceOf({})).issueDeadlineKey).toBeNull();
  });

  it("Verzugshinweis: festgeschrieben nur wenn gedruckt, Entwurf nur bei Vorgabe", () => {
    expect(card(invoiceOf({ consumerDefaultNotice: true }))).toContain("VerzugshinweisGedruckt (§ 286 Abs. 3 BGB)");
    expect(card(invoiceOf({ consumerDefaultNotice: false }))).not.toContain("Verzugshinweis");
    expect(card(invoiceOf({ consumerDefaultNotice: null }))).not.toContain("Verzugshinweis");
    expect(card(invoiceOf({ status: "DRAFT", consumerDefaultNotice: true }))).toContain("Immer drucken");
    expect(card(invoiceOf({ status: "DRAFT", consumerDefaultNotice: false }))).toContain("Nie drucken");
    expect(card(invoiceOf({ status: "DRAFT", consumerDefaultNotice: null }))).not.toContain("Verzugshinweis");
    expect(consumerNoticeOf({ status: "FINALIZED", consumerDefaultNotice: null })).toBe(false);
    expect(consumerNoticeOf({ status: "DRAFT", consumerDefaultNotice: null })).toBeNull();
  });
});

describe("Einstellungen", () => {
  it("Betrag 1.234,56 -> 123456 Cent, 1.234 -> Fehler", () => {
    expect(parseKuExternalRows(["2025"], ["1.234,56"])).toEqual({ ok: true, value: { "2025": 123_456 } });
    expect(parseKuExternalRows(["2025"], ["1234.56"])).toEqual({ ok: true, value: { "2025": 123_456 } });
    const bad = parseKuExternalRows(["2025"], ["1.234"]);
    expect(bad.ok).toBe(false);
  });
  it("Jahr, Betrag, Doppelte, negative Werte und leere Zeilen", () => {
    expect(parseKuExternalRows(["", "2024"], ["", "0"])).toEqual({ ok: true, value: { "2024": 0 } });
    expect(parseKuExternalRows(["25"], ["100"]).ok).toBe(false);
    expect(parseKuExternalRows(["2025"], [""]).ok).toBe(false);
    expect(parseKuExternalRows(["", ""], ["50", ""]).ok).toBe(false);
    expect(parseKuExternalRows(["2025", "2025"], ["1", "2"]).ok).toBe(false);
    expect(parseKuExternalRows(["2025"], ["-5"]).ok).toBe(false);
    expect(parseKuExternalRows(["2025"], ["abc"]).ok).toBe(false);
  });
  it("elftes Jahr -> Fehler, zehn Jahre ok", () => {
    const years = Array.from({ length: 11 }, (_, i) => String(2015 + i));
    const amounts = years.map(() => "1,00");
    expect(parseKuExternalRows(years.slice(0, 10), amounts.slice(0, 10)).ok).toBe(true);
    const r = parseKuExternalRows(years, amounts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("höchstens 10");
  });
  it("Formular zeigt Abschnitte, Vorbelegung, Satz und Hinweis", () => {
    const html = renderToStaticMarkup(
      <DocumentSettingsForm settings={{ ...documentSettingsInputSchema.parse({}), kuBusinessStartYear: 2024, kuExternalRevenue: { "2025": 123_456 }, consumerDefaultNotice: true }} />,
    );
    const t = text(html);
    expect(t).toContain("Kleinunternehmerregelung (§ 19 UStG)");
    expect(t).toContain("Rechnungen an Verbraucher");
    expect(t).toContain(de.notes.consumerDefaultNotice);
    expect(t).toContain(KU_NOTICE);
    expect(html).toContain('name="kuSettingsSent"');
    expect(html).toContain('name="consumerSettingsSent"');
    expect(html).toContain('name="kuWarnPercent"');
    expect(html).toContain('value="1.234,56"');
    expect(html).toContain('value="2025"');
    expect(html).toContain('value="2024"');
  });
});
