import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";

interface Row {
  id: string;
  number: string;
  customer: string;
  amount: string;
}

const ROWS: Row[] = [{ id: "1", number: "RE-50001", customer: "Muster GmbH", amount: "1.234,56 €" }];

const COLUMNS: DataColumn<Row>[] = [
  { key: "number", header: "Nummer", mobile: "title", cell: (r) => r.number },
  { key: "customer", header: "Kunde", mobile: "meta", cell: (r) => r.customer },
  { key: "amount", header: "Betrag", align: "right", mobile: "amount", cell: (r) => r.amount },
  { key: "internal", header: "Intern", mobile: "hidden", cell: () => "GEHEIM-INTERN" },
];

const EMPTY = { text: "Keine Rechnungen", action: { label: "Neue Rechnung", href: "/rechnungen/neu" } };

function render(rowHref?: (r: Row) => string, rows: Row[] = ROWS): string {
  return renderToStaticMarkup(
    <DataTable rows={rows} columns={COLUMNS} rowKey={(r) => r.id} rowHref={rowHref} empty={EMPTY} caption="Rechnungen" />,
  );
}

function cardsPart(html: string): string {
  return html.slice(html.indexOf("<ul"));
}

describe("DataTable", () => {
  it("rendert Tabelle und Karten aus denselben Spalten", () => {
    const html = render();
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    const cards = cardsPart(html);
    for (const part of [table, cards]) {
      expect(part).toContain("RE-50001");
      expect(part).toContain("1.234,56 €");
    }
    expect(table).toContain("hidden");
    expect(table).toContain("sm:table");
    expect(cards).toContain("sm:hidden");
  });

  it("leere Liste zeigt EmptyState mit Handlung", () => {
    const html = render(undefined, []);
    expect(html).not.toContain("<table");
    expect(html).toContain("Keine Rechnungen");
    expect(html).toContain('href="/rechnungen/neu"');
  });

  it("amount-Spalten sind rechtsbündig und nowrap", () => {
    const html = render();
    const td = html.match(/<td class="[^"]*">1\.234,56 €<\/td>/)?.[0] ?? "";
    expect(td).toContain("text-right");
    expect(td).toContain("tabular");
    expect(cardsPart(html)).toContain("whitespace-nowrap");
  });

  it("hidden-Spalten fehlen in Karten", () => {
    const html = render();
    expect(html).toContain("GEHEIM-INTERN");
    expect(cardsPart(html)).not.toContain("GEHEIM-INTERN");
  });

  it("rowHref setzt Link in Karte und erster Zelle", () => {
    const html = render((r) => `/rechnungen/${r.id}`);
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table).toMatch(/<td[^>]*><a [^>]*href="\/rechnungen\/1"[^>]*>RE-50001<\/a><\/td>/);
    expect(cardsPart(html)).toMatch(/<a [^>]*href="\/rechnungen\/1"[^>]*><span>RE-50001<\/span><\/a>/);
  });

  it("headerSrOnly versteckt nur die Kopfzelle visuell", () => {
    const cols: DataColumn<Row>[] = [
      { key: "select", header: "Auswahl", headerSrOnly: true, mobile: "meta", cell: () => "x" },
      ...COLUMNS,
    ];
    const html = renderToStaticMarkup(<DataTable rows={ROWS} columns={cols} rowKey={(r) => r.id} empty={EMPTY} caption="Rechnungen" />);
    const th = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
    expect(th).toContain('<span class="sr-only">Auswahl</span>');
    expect(cardsPart(html)).not.toContain("Auswahl");
    expect(render()).not.toContain('<span class="sr-only">Auswahl</span>');
  });
});
