/** Phase 13c, Task 1 — die Werkzeugleiste des eingebauten Browser-Betrachters ist wieder
 *  frei (Ruling "Kein PDF.js"). Kein RTL: renderToStaticMarkup + Strukturtest ueber die
 *  Quelldatei (Muster charts.test.tsx / dialogs.test.ts). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfStack } from "@/components/detail/PdfStack";

const SRC = path.resolve(__dirname, "../../src");

describe("PdfStack (Phase 13c)", () => {
  it("blendet die Werkzeugleiste NICHT mehr aus und startet mit FitH", () => {
    const html = renderToStaticMarkup(<PdfStack src="/api/invoices/i1/pdf" title="Rechnung — PDF" />);
    expect(html).not.toContain("toolbar=0");
    expect(html).not.toContain("navpanes=0");
    expect(html).toContain("/api/invoices/i1/pdf#view=FitH");
    expect(html).toContain("In neuem Tab öffnen");
    expect(html).toContain("Herunterladen");
  });

  it("ohne src bleibt der Hinweis", () => {
    const html = renderToStaticMarkup(<PdfStack src={null} title="t" emptyText="Noch kein PDF." />);
    expect(html).toContain("Noch kein PDF.");
    expect(html).not.toContain("<iframe");
  });

  it("der Umschalter merkt sich den Zustand unter oig.pdf.wide", () => {
    const bar = readFileSync(path.join(SRC, "components/detail/PdfViewToolbar.tsx"), "utf8");
    expect(bar).toContain('"use client"');
    expect(bar).toContain("oig.pdf.wide");
    // Lesen erst im Effekt — sonst weicht der erste Client-Render vom Server-HTML ab.
    expect(bar).toMatch(/useEffect\([\s\S]*localStorage\.getItem/);
  });
});
