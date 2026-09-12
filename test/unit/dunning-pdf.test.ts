import { describe, it, expect } from "vitest";
import { renderDunningPdf, type DunningPdfData } from "@/lib/pdf/dunning-pdf";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";

function baseData(overrides: Partial<DunningPdfData> = {}): DunningPdfData {
  return {
    number: "MB-2026-0001",
    level: 1,
    sentDate: new Date("2026-06-01T10:00:00Z"),
    newDueDate: new Date("2026-06-10T10:00:00Z"),
    currency: "EUR",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin" },
    buyer: { name: "Kunde AG", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt" },
    invoiceNumber: "RE-2026-0001",
    invoiceDate: new Date("2026-05-01T10:00:00Z"),
    openAmountCents: 10000,
    interestCents: 0,
    flatFee40Cents: 0,
    feeCents: 0,
    lateFeeCents: 0,
    totalCents: 10000,
    daysOverdue: 30,
    ...overrides,
  };
}

describe("renderDunningPdf — deDate Zeitzone (Fix nach Task 3)", () => {
  it("Grenzfall: Segment-Enddatum kurz vor Mitternacht Berliner Zeit (23:30 UTC im Winter = 00:30 CET Folgetag) zeigt den Berliner Tag, nicht den UTC-Tag", async () => {
    // 2026-01-05T23:30:00Z entspricht in Europe/Berlin (CET, UTC+1 im Januar) bereits
    // 2026-01-06 00:30 — ohne `timeZone` in `deDate()` (bzw. bei UTC-Serverlauf) haette
    // das PDF hier faelschlich den 05.01.2026 gezeigt.
    const data = baseData({
      interestCents: 500,
      totalCents: 10500,
      interestSegments: [
        {
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-05T23:30:00Z",
          days: 5,
          baseRateBp: 342,
          pointsBp: 900,
          interestCents: 500,
        },
      ],
    });
    const pdf = await renderDunningPdf(data, testPdfTheme());
    const { text } = await parsePdf(pdf);
    // Kein Praefix ("bis ") im Vergleich — bei schmalen Spalten kann pdfkit/pdf-parse
    // an der Stelle umbrechen; das faelschlich UTC-basierte Datum darf trotzdem nicht auftauchen.
    expect(text).toContain("06.01.2026");
    expect(text).not.toContain("05.01.2026");
  });

  it("Grenzfall: Zahlungsfrist (newDueDate) kurz vor Mitternacht Berliner Zeit zeigt den Berliner Tag", async () => {
    // 2026-01-05T23:30:00Z -> 06.01.2026 in Europe/Berlin.
    const data = baseData({ newDueDate: new Date("2026-01-05T23:30:00Z") });
    const pdf = await renderDunningPdf(data, testPdfTheme());
    const { text } = await parsePdf(pdf);
    expect(text).toContain("06.01.2026");
    expect(text).not.toContain("05.01.2026");
  });
});
