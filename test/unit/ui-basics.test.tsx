import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Button } from "@/components/ui/Button";
import { Kpi } from "@/components/ui/Kpi";

describe("ProgressBar", () => {
  it("rechnet Prozent abgeschnitten", () => {
    const html = renderToStaticMarkup(<ProgressBar valueCents={10000} totalCents={23681} label="Bezahlt" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain(" von ");
  });

  it("begrenzt Überzahlung auf 100", () => {
    expect(renderToStaticMarkup(<ProgressBar valueCents={30000} totalCents={23681} label="Bezahlt" />)).toContain('aria-valuenow="100"');
  });
});

describe("Button", () => {
  it("danger-quiet hat text-stamp und keinen Hintergrund", () => {
    const html = renderToStaticMarkup(<Button variant="danger-quiet">Löschen</Button>);
    expect(html).toContain("text-stamp");
    expect(html).not.toMatch(/(?<![:-])bg-/);
  });
});

describe("Kpi", () => {
  it("Hero-Größe nutzt 40 px, Standard 22 px", () => {
    expect(renderToStaticMarkup(<Kpi label="Offen" value="1 €" size="hero" />)).toContain("text-[40px]");
    expect(renderToStaticMarkup(<Kpi label="Offen" value="1 €" />)).toContain("text-[22px]");
  });
});
