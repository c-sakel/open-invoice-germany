import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { FilterBar, activeFilterCount, type FilterField } from "@/components/list/FilterBar";

const FIELDS: FilterField[] = [
  { type: "text", name: "q", label: "Suche" },
  { type: "select", name: "status", label: "Status", options: [{ value: "OPEN", label: "Offen" }] },
  { type: "date", name: "from", label: "Von" },
  { type: "date", name: "to", label: "Bis" },
];

describe("FilterBar", () => {
  it("zählt aktive Filter ohne Suchfeld", () => {
    expect(activeFilterCount({ q: "x", status: "OPEN", from: "2026-01-01" }, FIELDS)).toBe(2);
  });
  it("leere Strings zählen nicht", () => {
    expect(activeFilterCount({ q: "", status: "", from: undefined }, FIELDS)).toBe(0);
  });
  it("Button zeigt Filter (2)", () => {
    const html = renderToStaticMarkup(<FilterBar basePath="/rechnungen" fields={FIELDS} values={{ status: "OPEN", from: "2026-01-01" }} />);
    expect(html).toContain("Filter (2)");
    expect(html).toContain("Offen");
  });
  it("Zurücksetzen-Link ohne Query", () => {
    const html = renderToStaticMarkup(<FilterBar basePath="/rechnungen" fields={FIELDS} values={{ status: "OPEN" }} />);
    expect(html).toContain('href="/rechnungen"');
    expect(html).toContain("Zurücksetzen");
  });
});
