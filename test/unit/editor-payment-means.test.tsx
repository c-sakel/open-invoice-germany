import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MetaBlock } from "@/components/editor/blocks/MetaBlock";
import { CustomerForm } from "@/components/forms/CustomerForm";
import { OrganizationForm } from "@/components/forms/OrganizationForm";
import { MandateInfo } from "@/components/customers/MandateInfo";
import { emptyDraft, toInvoicePayload, draftFromInvoice, type DraftState } from "@/lib/editor/draft";

const methods = [
  { id: "m54", name: "Kreditkarte", untdidCode: "54" },
  { id: "m58", name: "SEPA-Überweisung", untdidCode: "58" },
  { id: "m59", name: "SEPA-Lastschrift", untdidCode: "59" },
];

function render(methodId: string) {
  const draft: DraftState = { ...emptyDraft("INVOICE"), paymentMethodId: methodId };
  return renderToStaticMarkup(<MetaBlock mode="INVOICE" isEdit={false} draft={draft} dispatch={() => {}} paymentMethods={methods} />);
}

describe("MetaBlock Zahlungsmittel (18e)", () => {
  it("Karte (54): Kartenfelder mit Vorschlagsliste", () => {
    const html = render("m54");
    expect(html).toContain("Kartennetz");
    expect(html).toContain("<datalist");
    expect(html).toContain('value="VISA"');
    expect(html).toContain("Letzte 4 Ziffern");
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('maxLength="19"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("Karteninhaber");
  });

  it("Überweisung (58): keine Kartenfelder", () => {
    const html = render("m58");
    expect(html).not.toContain("Kartennetz");
    expect(html).not.toContain("Letzte 4 Ziffern");
    expect(html).not.toContain("Mandat und Gläubiger-ID");
  });

  it("Lastschrift (59): Hinweis auf Mandat", () => {
    const html = render("m59");
    expect(html).toContain("Mandat und Gläubiger-ID werden beim Festschreiben übernommen.");
    expect(html).not.toContain("Kartennetz");
  });
});

describe("Entwurf Kartenfelder", () => {
  it("leere Werte werden zu null, gefüllte getrimmt", () => {
    const empty = toInvoicePayload(emptyDraft("INVOICE"), false);
    expect(empty.cardPanTruncated).toBeNull();
    expect(empty.cardNetwork).toBeNull();
    expect(empty.cardHolderName).toBeNull();
    const filled = toInvoicePayload({ ...emptyDraft("INVOICE"), cardPanTruncated: " 1234 ", cardNetwork: "VISA", cardHolderName: "A B" }, true);
    expect(filled.cardPanTruncated).toBe("1234");
    expect(filled.cardNetwork).toBe("VISA");
    expect(filled.cardHolderName).toBe("A B");
  });

  it("draftFromInvoice übernimmt die Kartenfelder", () => {
    const base = draftFromInvoice({ id: "x", customerId: "c", taxScheme: "REGULAR", lines: [] } as unknown as Parameters<typeof draftFromInvoice>[0]);
    expect(base.cardPanTruncated).toBe("");
    const d = draftFromInvoice({ id: "x", customerId: "c", taxScheme: "REGULAR", lines: [], cardPanTruncated: "1234", cardNetwork: "VISA", cardHolderName: "A B" } as unknown as Parameters<typeof draftFromInvoice>[0]);
    expect([d.cardPanTruncated, d.cardNetwork, d.cardHolderName]).toEqual(["1234", "VISA", "A B"]);
  });
});

describe("Stammdaten-Formulare (18e)", () => {
  it("CustomerForm zeigt den Mandatsblock mit vier Feldern", () => {
    const html = renderToStaticMarkup(<CustomerForm />);
    expect(html).toContain("SEPA-Lastschriftmandat");
    for (const n of ["sepaMandateReference", "sepaMandateSignedAt", "sepaDebitIban", "sepaDebitAccountName"]) expect(html).toContain(`name="${n}"`);
  });

  it("OrganizationForm zeigt Gläubiger-ID mit Hinweis", () => {
    const html = renderToStaticMarkup(<OrganizationForm />);
    expect(html).toContain("Gläubiger-ID (SEPA)");
    expect(html).toContain("Nur für Lastschriften nötig.");
  });

  it("Kundendetail zeigt Referenz, Datum und maskierte IBAN", () => {
    const html = renderToStaticMarkup(
      <MandateInfo customer={{ sepaMandateReference: "MANDAT-2184-001", sepaMandateSignedAt: "2184-03-05", sepaDebitIbanMasked: "DE02 **** 2051" }} />,
    );
    expect(html).toContain("MANDAT-2184-001");
    expect(html).toContain("05.03.2184");
    expect(html).toContain("DE02 **** 2051");
  });
});
