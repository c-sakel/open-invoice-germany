import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode }) => <a href={props.href}>{props.children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { DataTable } = await import("@/components/ui/DataTable");
const { RowActionsMenu } = await import("@/components/list/RowActionsMenu");

interface Row {
  id: string;
}

describe("Listen-Markup: keine Doppelung je Breite", () => {
  it("DataTable nutzt mobileCell nur in der Kartenliste, cell nur in der Tabelle", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row>
        rows={[{ id: "a" }]}
        columns={[
          { key: "t", header: "T", mobile: "title", cell: () => "TITEL" },
          { key: "s", header: "S", mobile: "meta", cell: () => "DESKTOP", mobileCell: () => "KARTE" },
          { key: "x", header: "X", mobile: "meta", cell: () => "BEIDE" },
        ]}
        rowKey={(r) => r.id}
        empty={{ text: "leer" }}
        caption="Test"
      />,
    );
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    const list = html.slice(html.indexOf("<ul"));
    expect(table).toContain("DESKTOP");
    expect(table).not.toContain("KARTE");
    expect(list).toContain("KARTE");
    expect(list).not.toContain("DESKTOP");
    expect(table).toContain("BEIDE");
    expect(list).toContain("BEIDE");
  });

  it("RowActionsMenu liefert im geschlossenen Zustand weder Dialoge noch Zahlungsformular mit", () => {
    const html = renderToStaticMarkup(
      <RowActionsMenu
        kind="INVOICE"
        id="i1"
        actions={["OPEN", "PDF", "SEND", "PAYMENT", "CANCEL", "TEMPLATE_SAVE"]}
        openHref="/rechnungen/i1"
        pdfHref="/api/invoices/i1/pdf"
        emailDocType="INVOICE"
        cancelRoute="/api/invoices/i1/cancel"
        payment={{ openCents: 1000, methods: [{ code: "BANK_TRANSFER", name: "Überweisung" }], defaultMethod: "BANK_TRANSFER" }}
      />,
    );
    // Direktknoepfe und Menue-Schalter bleiben sichtbar ...
    expect(html).toContain(">PDF</a>");
    expect(html).toContain(">Zahlung</button>");
    expect(html).toContain('aria-label="Aktionen"');
    // ... der Inhalt (Dialoge, Formulare, Menuepunkte) wird erst beim Oeffnen gerendert.
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Stornieren");
    expect(html).not.toContain("Überweisung");
    expect(html.length).toBeLessThan(1200);
  });
});
