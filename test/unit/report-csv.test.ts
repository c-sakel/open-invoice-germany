/** Phase 17c, Task 3 — reines CSV-Format der Auswertungen. */
import { describe, it, expect } from "vitest";
import { csvTextCell, reportToCsv, reportCsvFilename, CSV_BOM } from "@/domain/reporting/csv";
import type { ReportResult } from "@/domain/reporting/query";

const R = "Report" as const;
const lines = (s: string) => s.split("\r\n");

describe("csvTextCell", () => {
  it("entschaerft Formelzeichen mit Apostroph", () => {
    expect(csvTextCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    for (const v of ["+1", "-Firma", "@x", "\tA", "\rA", "  =1+1", "\u3000=A1", "\uFF1DA1", "\uFF0B1", "\uFF20x"]) {
      expect(csvTextCell(v).replace(/^"/, "").startsWith("'"), JSON.stringify(v)).toBe(true);
    }
  });
  it("quotet Trennzeichen und verdoppelt Anfuehrungszeichen", () => {
    expect(csvTextCell("A;B")).toBe('"A;B"');
    expect(csvTextCell('Sag "Hallo"')).toBe('"Sag ""Hallo"""');
  });
  it("null -> leer, normaler Text unveraendert", () => {
    expect(csvTextCell(null)).toBe("");
    expect(csvTextCell("Muster GmbH")).toBe("Muster GmbH");
  });
});

describe("reportToCsv", () => {
  it("Betragsspalten werden nicht entschaerft", () => {
    const csv = reportToCsv({ objectName: R, type: "revenue", rows: [{ month: "2152-04", netCents: -123456, count: 2 }, { month: "2152-05", netCents: 5, count: 1 }] });
    expect(lines(csv)).toEqual(["Monat;Netto;Anzahl", "2152-04;-1234,56;2", "2152-05;0,05;1", ""]);
    expect(csv).not.toContain(CSV_BOM);
  });

  it("top-customers: Kopfzeile, Formelschutz im Namen", () => {
    const csv = reportToCsv({ objectName: R, type: "top-customers", rows: [{ customerId: "c1", name: "=SUMME(A1)", netCents: 100, invoiceCount: 1 }] });
    expect(lines(csv)).toEqual(["Kunde;Kunden-ID;Netto;Rechnungen", "'=SUMME(A1);c1;1,00;1", ""]);
  });

  it("status", () => {
    const csv = reportToCsv({ objectName: R, type: "status", rows: [{ status: "OPEN", label: "Offen", count: 3, openCents: 1990 }] });
    expect(lines(csv)).toEqual(["Status;Anzahl;Offen", "Offen;3;19,90", ""]);
  });

  it("payment-behaviour mit Werten und null", () => {
    expect(lines(reportToCsv({ objectName: R, type: "payment-behaviour", rows: [{ avgDaysToPay: 12.34, onTimeShare: 0.8756, paidCount: 7 }] }))).toEqual([
      "Ø Tage bis Zahlung;Pünktlich (%);Bezahlte Rechnungen",
      "12,3;87,6;7",
      "",
    ]);
    expect(lines(reportToCsv({ objectName: R, type: "payment-behaviour", rows: [{ avgDaysToPay: null, onTimeShare: null, paidCount: 0 }] }))[1]).toBe(";;0");
  });

  it("cash-in", () => {
    const csv = reportToCsv({ objectName: R, type: "cash-in", rows: [{ month: "2152-04", currency: "EUR", paidCents: 1000, invoicedGrossCents: 2000 }] });
    expect(lines(csv)).toEqual(["Monat;Währung;Zahlungseingang;Rechnungsausgang brutto", "2152-04;EUR;10,00;20,00", ""]);
  });

  it("quote-outcome", () => {
    const b = (count: number, netCents: number) => ({ count, netCents });
    const csv = reportToCsv({ objectName: R, type: "quote-outcome", rows: [{ currency: "EUR", accepted: b(1, 100), rejected: b(2, 200), expired: b(3, 300), open: b(4, 400), acceptedPermille: 333 }] });
    expect(lines(csv)).toEqual([
      "Währung;Angenommen;Angenommen netto;Abgelehnt;Abgelehnt netto;Abgelaufen;Abgelaufen netto;Offen;Offen netto;Annahmequote (%)",
      "EUR;1;1,00;2;2,00;3;3,00;4;4,00;33,3",
      "",
    ]);
  });

  it("top-products mit Menge", () => {
    const csv = reportToCsv({ objectName: R, type: "top-products", rows: [{ productId: "p1", name: "A;B", currency: "EUR", netCents: 250, quantityMilli: 1500 }] });
    expect(lines(csv)).toEqual(["Produkt;Produkt-ID;Währung;Netto;Menge", '"A;B";p1;EUR;2,50;1,500', ""]);
  });

  it("recurring-run-rate", () => {
    const csv = reportToCsv({ objectName: R, type: "recurring-run-rate", rows: [{ currency: "EUR", monthlyNetCents: 9900, activeCount: 2, skipped: 1 }] });
    expect(lines(csv)).toEqual(["Währung;Monatlich netto;Aktive Abos;Ohne Intervall", "EUR;99,00;2;1", ""]);
  });

  it("leere Zeilen -> nur Kopfzeile", () => {
    const r: ReportResult = { objectName: R, type: "revenue", rows: [] };
    expect(reportToCsv(r)).toBe("Monat;Netto;Anzahl\r\n");
  });
});

describe("reportCsvFilename", () => {
  it("nutzt das Berliner Datum", () => {
    expect(reportCsvFilename("revenue", new Date("2152-03-31T22:30:00Z"))).toBe("auswertung-revenue-2152-04-01.csv");
  });
});
