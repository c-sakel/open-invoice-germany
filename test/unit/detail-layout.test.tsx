/** Phase 13c, Task 2 — breiteres Raster, Belegkarte mit Nav, getrennte Karten. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentDetailLayout } from "@/components/detail/DocumentDetailLayout";
import { DetailCard } from "@/components/detail/DetailCard";

function render() {
  return renderToStaticMarkup(
    <DocumentDetailLayout
      nav={<span>NAV-MARKER</span>}
      title="Rechnung RE-1001"
      pdf={<span>PDF</span>}
      aside={<DetailCard title="Details">Inhalt</DetailCard>}
    >
      <span>UNTEN</span>
    </DocumentDetailLayout>,
  );
}

describe("DocumentDetailLayout (Phase 13c)", () => {
  it("nutzt das breitere xl-Raster mit 24rem-Spalte", () => {
    const html = render();
    expect(html).toContain("xl:grid-cols-[minmax(0,1fr)_24rem]");
    expect(html).not.toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");
  });

  it("zeigt die Navigation in der Belegkarte, nicht mehr ueber dem Titel", () => {
    const html = render();
    const asideStart = html.indexOf("<aside");
    expect(asideStart).toBeGreaterThan(0);
    expect(html.indexOf("NAV-MARKER")).toBeGreaterThan(asideStart);
    expect(html).toContain("Beleg");
    expect(html).toContain("Rechnung RE-1001");
  });

  it("DetailCard rendert Titel und Inhalt", () => {
    expect(renderToStaticMarkup(<DetailCard title="Anhänge">X</DetailCard>)).toContain("Anhänge");
  });
});
