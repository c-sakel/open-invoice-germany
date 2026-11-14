import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { UsageSection, type UsageSectionLine, type UsageSectionRow } from "@/app/abos/[id]/_parts/UsageSection";
import { UsageForm } from "@/components/recurring/UsageForm";
import { LineRow } from "@/components/editor/blocks/LineRow";
import { draftLinesFromInitial, draftLinesToPayload, draftReducer, emptyDraft, type DraftLine } from "@/lib/editor/draft";
import { parseUsageQuantity, formatUsageQuantity, USAGE_QUANTITY_AMBIGUOUS } from "@/lib/recurring-usage-format";

const D = (iso: string) => new Date(`${iso}T10:00:00.000Z`);
const lines: UsageSectionLine[] = [
  { id: "l-fix", description: "Grundgebühr", usageUnitLabel: null, billing: "FIXED" },
  { id: "l-use", description: "API-Aufrufe", usageUnitLabel: "Aufrufe", billing: "USAGE" },
];
const row = (over: Partial<UsageSectionRow>): UsageSectionRow => ({
  id: "u1",
  recurringLineId: "l-use",
  usageDate: D("2187-03-10"),
  periodStart: D("2187-03-01"),
  periodEnd: D("2187-03-31"),
  quantityMilli: 6_000_000,
  note: null,
  status: "open",
  invoiceId: null,
  invoiceNumber: null,
  voidReason: null,
  ...over,
});

describe("UsageSection", () => {
  const html = renderToStaticMarkup(
    <UsageSection
      recurringId="r1"
      recurringStatus="ACTIVE"
      lines={lines}
      total={3}
      open={[{ recurringLineId: "l-use", quantityMilli: 10_000_000, periodEnd: D("2187-03-31") }]}
      rows={[
        row({ id: "u1" }),
        row({ id: "u2", status: "billed", invoiceId: "inv-9", invoiceNumber: "RE-2187-1", quantityMilli: 4_000_000 }),
        row({ id: "u3", status: "voided", voidReason: "Doppelt gemeldet", quantityMilli: 1_000 }),
      ]}
    />,
  );

  it("zeigt Tabelle mit caption, Status, Rechnungslink und Summe offen je Position", () => {
    expect(html).toContain("<caption");
    expect(html).toContain("offen</td>");
    expect(html).toContain("abgerechnet:");
    expect(html).toContain('href="/rechnungen/inv-9"');
    expect(html).toContain("RE-2187-1");
    expect(html).toContain("storniert: Doppelt gemeldet");
    expect(html).toContain("10.000 Aufrufe offen bis 31.03.2187");
    expect(html).toContain("Verbrauch erfassen");
  });

  it("Storno-Knopf nur beim offenen Satz", () => {
    expect(html.match(/text-xs font-medium text-stamp hover:underline/g)?.length).toBe(1);
  });

  it("ohne Verbrauchsposition rendert nichts", () => {
    const out = renderToStaticMarkup(
      <UsageSection recurringId="r1" recurringStatus="ACTIVE" lines={[lines[0]!]} rows={[]} total={0} open={[]} />,
    );
    expect(out).toBe("");
  });

  it("pausiertes Abo: Hinweis statt Formular; Hinweis auf REST bei mehr Saetzen", () => {
    const out = renderToStaticMarkup(<UsageSection recurringId="r1" recurringStatus="PAUSED" lines={lines} rows={[row({})]} total={250} open={[]} />);
    expect(out).not.toContain("Verbrauch erfassen");
    expect(out).toContain("nur für aktive Abos");
    expect(out).toContain("letzten 1 von 250");
    expect(out).toContain("/api/v1/Recurring/r1/usage");
  });
});

describe("UsageForm", () => {
  it("Mengenfeld mit Hinweis und Live-Region", () => {
    const out = renderToStaticMarkup(<UsageForm recurringId="r1" lines={[{ id: "l-use", description: "API-Aufrufe", unitLabel: "Aufrufe" }]} />);
    expect(out).toContain("bis 3 Nachkommastellen");
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("API-Aufrufe (Aufrufe)");
  });

  it("Mengenparser: Komma, Milli, Null und mehrdeutiger Tausenderpunkt", () => {
    expect(parseUsageQuantity("2,5")).toEqual({ milli: 2500 });
    expect(parseUsageQuantity("10000")).toEqual({ milli: 10_000_000 });
    expect(parseUsageQuantity("10.000,5")).toEqual({ milli: 10_000_500 });
    expect(parseUsageQuantity("10.000")).toEqual({ error: USAGE_QUANTITY_AMBIGUOUS });
    expect("error" in parseUsageQuantity("0")).toBe(true);
    expect("error" in parseUsageQuantity("abc")).toBe(true);
    expect(formatUsageQuantity(10_000_000)).toBe("10.000");
  });
});

describe("LineRow Abo-Modus", () => {
  const base: DraftLine = { ...emptyDraft("INVOICE").lines[0]!, description: "API-Aufrufe", price: "0,002" };
  const render = (line: DraftLine, recurring: boolean) =>
    renderToStaticMarkup(
      <table>
        <tbody>
          <LineRow
            line={line}
            mode="INVOICE"
            recurring={recurring}
            taxRates={[19, 7, 0]}
            itemPos={1}
            isLast
            taxDisabled={false}
            grossDisplay={false}
            products={[]}
            dispatch={() => {}}
            subtotalCents={0}
            canRemove={false}
            registerDescRef={() => {}}
            onEnterLast={() => {}}
            handleProps={{} as never}
            rowRef={() => {}}
            dragging={false}
            canMove={() => false}
            onMove={() => {}}
            onRowKeyDown={() => {}}
          />
        </tbody>
      </table>,
    );

  it("Abo-Modus zeigt die Auswahl fest / nach Verbrauch", () => {
    const html = render(base, true);
    expect(html).toContain("Abrechnung");
    expect(html).toContain(">fest<");
    expect(html).toContain(">nach Verbrauch<");
    expect(html).toContain('aria-label="Menge"');
  });

  it("USAGE: statt Menge Text und Einheitentext", () => {
    const html = render({ ...base, billing: "USAGE", quantity: "0", usageUnitLabel: "Aufrufe" }, true);
    expect(html).not.toContain('aria-label="Menge"');
    expect(html).toContain("nach Verbrauch</span>");
    expect(html).toContain('aria-label="Einheitentext"');
    expect(html).toContain('value="Aufrufe"');
  });

  it("ausserhalb des Abo-Modus keine Auswahl", () => {
    const html = render(base, false);
    expect(html).not.toContain("Abrechnung");
    expect(html).not.toContain("nach Verbrauch");
  });
});

describe("Entwurf <-> Abo-Zeilen-Payload", () => {
  it("haelt die Zeilen-Id, setzt USAGE auf Menge 0 und laesst Nicht-Abo-Payload unveraendert", () => {
    const [fixed, usage] = draftLinesFromInitial(
      [
        { lineType: "ITEM", description: "Grund", descriptionLong: "", articleNumber: "", quantity: "1", unit: "C62", price: "29,00", taxRate: 19, discountPercent: "0", discountAmount: "0,00", recurringLineId: "l-fix", billing: "FIXED" },
        { lineType: "ITEM", description: "API", descriptionLong: "", articleNumber: "", quantity: "0", unit: "C62", price: "0,002", taxRate: 19, discountPercent: "0", discountAmount: "0,00", recurringLineId: "l-use", billing: "USAGE", usageUnitLabel: "Aufrufe" },
      ],
      [19],
    );
    expect(fixed!.recurringLineId).toBe("l-fix");
    const out = draftLinesToPayload([fixed!, usage!], "REGULAR", { recurring: true });
    expect(out[0]).toMatchObject({ id: "l-fix", billing: "FIXED", quantityMilli: 1000 });
    expect(out[1]).toMatchObject({ id: "l-use", billing: "USAGE", quantityMilli: 0, usageUnitLabel: "Aufrufe", unitNetPriceMilliCents: 200 });
    const plain = draftLinesToPayload([usage!], "REGULAR")[0]!;
    expect("billing" in plain).toBe(false);
    expect("id" in plain).toBe(false);
  });

  it("Duplizieren vergibt keine doppelte Zeilen-Id", () => {
    let s = emptyDraft("INVOICE");
    const key = s.lines[0]!.key;
    s = draftReducer(s, { type: "setLine", key, patch: { recurringLineId: "l-x" } });
    s = draftReducer(s, { type: "duplicateLine", key });
    expect(s.lines.map((l) => l.recurringLineId)).toEqual(["l-x", undefined]);
  });
});
