import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BelegStrecke } from "@/components/BelegStrecke";
import { BelegStreckeMini } from "@/components/BelegStreckeMini";
import { belegStrecke } from "@/domain/timeline/belegstrecke";

const steps = belegStrecke({ status: "SENT", sent: true, paidAmountCents: 0, payableCents: 1000 });

describe("BelegStrecke", () => {
  it("lg: Liste mit Beschriftung, aktueller Schritt aria-current, alle Texte sichtbar", () => {
    const html = renderToStaticMarkup(<BelegStrecke steps={steps} size="lg" />);
    expect(html).toContain('aria-label="Belegstrecke"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).not.toContain("sr-only");
    for (const label of ["Entwurf", "Festgeschrieben", "Versendet", "Teilbezahlt", "Bezahlt"]) expect(html).toContain(label);
  });

  it("sm: nur der aktuelle Text sichtbar, uebrige sr-only", () => {
    const html = renderToStaticMarkup(<BelegStrecke steps={steps} size="sm" />);
    expect(html.match(/sr-only/g)).toHaveLength(4);
  });

  it("Mini nutzt dieselbe Ableitung und ignoriert unbekannte Status", () => {
    expect(renderToStaticMarkup(<BelegStreckeMini status="PAID" />)).toContain("Bezahlt");
    expect(renderToStaticMarkup(<BelegStreckeMini status="XYZ" />)).toBe("");
  });
});
