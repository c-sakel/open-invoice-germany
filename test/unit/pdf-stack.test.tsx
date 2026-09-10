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

  it("Fix-Welle 1 (S3): kein Breit/Schmal-Umschalter mehr (aenderte nie tatsaechlich die Breite)", () => {
    const bar = readFileSync(path.join(SRC, "components/detail/PdfViewToolbar.tsx"), "utf8");
    expect(bar).not.toContain("oig.pdf.wide");
    expect(bar).not.toMatch(/>\s*Breit\s*</);
    expect(bar).not.toMatch(/>\s*Schmal\s*</);
  });
});
