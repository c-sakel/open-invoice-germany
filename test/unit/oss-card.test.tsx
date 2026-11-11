/** Phase 16e, Task 5 — Dashboard-Karte OSS-Schwelle (statisch gerendert). */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OssCard } from "@/components/dashboard/OssCard";
import type { OssThreshold } from "@/domain/reporting/oss";
import { OSS_NOTICE } from "@/schemas/oss";

function fixture(over: Partial<OssThreshold> = {}, cur: Partial<OssThreshold["current"]> = {}, prev: Partial<OssThreshold["previous"]> = {}): OssThreshold {
  return {
    thresholdCents: 1_000_000,
    warnPercent: 80,
    mode: "ALL_EU_B2C",
    level: "WARN",
    previousYearExceeded: false,
    current: { year: 2119, netEurCents: 850000, percent: 85, documentCount: 3, skippedWithoutEur: 0, byCountry: [{ countryCode: "AT", netEurCents: 850000 }], ...cur },
    previous: { year: 2118, netEurCents: 120000, percent: 12, documentCount: 1, skippedWithoutEur: 0, byCountry: [], ...prev },
    notice: OSS_NOTICE,
    ...over,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/ /g, " ");

describe("OssCard", () => {
  it("zeigt Stand, Prozent, Vorjahr, Laender und Hinweis", () => {
    const t = text(renderToStaticMarkup(<OssCard oss={fixture()} />));
    expect(t).toContain("EU-Fernverkäufe / OSS-Schwelle");
    expect(t).toContain("8.500,00 € von 10.000,00 €");
    expect(t).toContain("85 %");
    expect(t).toContain("Vorjahr: 1.200,00 €");
    expect(t).toContain("Österreich");
    expect(t).toContain(OSS_NOTICE);
    expect(t).not.toContain("Fremdwährungsbeleg");
    expect(t).not.toContain("Schwelle im Vorjahr überschritten");
  });

  it("zeigt die Prozentzahl aus der Domain ohne Float-Rechnung (2.900 EUR = 29 %)", () => {
    const t = text(renderToStaticMarkup(<OssCard oss={fixture({ level: "OK" }, { netEurCents: 290000, percent: 29 })} />));
    expect(t).toContain("29 %");
    expect(t).not.toContain("28 %");
  });

  it("weist auf nicht gezaehlte Fremdwaehrungsbelege hin", () => {
    const t = text(renderToStaticMarkup(<OssCard oss={fixture({}, { skippedWithoutEur: 2 })} />));
    expect(t).toContain("2 Fremdwährungsbelege ohne EUR-Betrag nicht gezählt");
  });

  it("meldet Ueberschreitung im Vorjahr", () => {
    const t = text(renderToStaticMarkup(<OssCard oss={fixture({ level: "EXCEEDED", previousYearExceeded: true })} />));
    expect(t).toContain("Schwelle im Vorjahr überschritten");
  });

  it("zeigt hoechstens fuenf Laender", () => {
    const byCountry = ["AT", "FR", "IT", "ES", "NL", "BE"].map((countryCode, i) => ({ countryCode, netEurCents: 600000 - i * 1000 }));
    const html = renderToStaticMarkup(<OssCard oss={fixture({}, { byCountry })} />);
    expect(html.match(/<li/g)).toHaveLength(5);
  });
});
