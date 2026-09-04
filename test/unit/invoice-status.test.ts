import { describe, it, expect } from "vitest";
import { effectiveInvoiceStatus, INVOICE_STATUS_LABEL } from "@/domain/invoice/status";

// Lokale Zeit (nicht UTC-Z-Strings) — effectiveInvoiceStatus vergleicht tagesgenau
// in lokaler Zeit (analog effectiveQuoteStatus); Z-Strings nahe der Mitternachtsgrenze
// wuerden je nach Test-Timezone auf den falschen Kalendertag fallen.
const NOW = new Date(2063, 5, 15, 10, 0, 0);
const YESTERDAY = new Date(2063, 5, 14);
const TODAY = new Date(2063, 5, 15);
const TOMORROW = new Date(2063, 5, 16);
const ISSUE = new Date(2063, 5, 1);

describe("effectiveInvoiceStatus", () => {
  it("DRAFT bleibt DRAFT unabhaengig von dueDate", () => {
    expect(effectiveInvoiceStatus({ status: "DRAFT", dueDate: YESTERDAY, issueDate: ISSUE }, NOW)).toBe("DRAFT");
    expect(effectiveInvoiceStatus({ status: "DRAFT", dueDate: null, issueDate: ISSUE }, NOW)).toBe("DRAFT");
  });

  it("PAID bleibt PAID unabhaengig von dueDate", () => {
    expect(effectiveInvoiceStatus({ status: "PAID", dueDate: YESTERDAY, issueDate: ISSUE }, NOW)).toBe("PAID");
  });

  it("PARTIALLY_PAID bleibt PARTIALLY_PAID unabhaengig von dueDate", () => {
    expect(effectiveInvoiceStatus({ status: "PARTIALLY_PAID", dueDate: YESTERDAY, issueDate: ISSUE }, NOW)).toBe("PARTIALLY_PAID");
    expect(effectiveInvoiceStatus({ status: "PARTIALLY_PAID", dueDate: TOMORROW, issueDate: ISSUE }, NOW)).toBe("PARTIALLY_PAID");
  });

  it("CANCELLED bleibt CANCELLED unabhaengig von dueDate", () => {
    expect(effectiveInvoiceStatus({ status: "CANCELLED", dueDate: YESTERDAY, issueDate: ISSUE }, NOW)).toBe("CANCELLED");
  });

  it("FINALIZED ohne dueDate ist OPEN", () => {
    expect(effectiveInvoiceStatus({ status: "FINALIZED", dueDate: null, issueDate: ISSUE }, NOW)).toBe("OPEN");
  });

  it("SENT ohne dueDate ist OPEN", () => {
    expect(effectiveInvoiceStatus({ status: "SENT", dueDate: null, issueDate: ISSUE }, NOW)).toBe("OPEN");
  });

  it("FINALIZED mit dueDate gestern ist OVERDUE", () => {
    expect(effectiveInvoiceStatus({ status: "FINALIZED", dueDate: YESTERDAY, issueDate: ISSUE }, NOW)).toBe("OVERDUE");
  });

  it("FINALIZED mit dueDate heute ist DUE", () => {
    expect(effectiveInvoiceStatus({ status: "FINALIZED", dueDate: TODAY, issueDate: ISSUE }, NOW)).toBe("DUE");
  });

  it("FINALIZED mit dueDate morgen ist OPEN", () => {
    expect(effectiveInvoiceStatus({ status: "FINALIZED", dueDate: TOMORROW, issueDate: ISSUE }, NOW)).toBe("OPEN");
  });

  it("SENT mit dueDate gestern ist OVERDUE", () => {
    expect(effectiveInvoiceStatus({ status: "SENT", dueDate: YESTERDAY, issueDate: ISSUE }, NOW)).toBe("OVERDUE");
  });

  it("SENT mit dueDate heute ist DUE", () => {
    expect(effectiveInvoiceStatus({ status: "SENT", dueDate: TODAY, issueDate: ISSUE }, NOW)).toBe("DUE");
  });

  it("SENT mit dueDate morgen ist OPEN", () => {
    expect(effectiveInvoiceStatus({ status: "SENT", dueDate: TOMORROW, issueDate: ISSUE }, NOW)).toBe("OPEN");
  });

  it("dueDate exakt an der Mitternachtsgrenze zaehlt tagesgenau, nicht per Uhrzeit", () => {
    const dueLateToday = new Date(2063, 5, 15, 23, 59, 0);
    expect(effectiveInvoiceStatus({ status: "FINALIZED", dueDate: dueLateToday, issueDate: ISSUE }, NOW)).toBe("DUE");
  });

  it("INVOICE_STATUS_LABEL deckt alle acht Zustaende ab", () => {
    const keys: Array<keyof typeof INVOICE_STATUS_LABEL> = [
      "DRAFT", "FINALIZED", "OPEN", "DUE", "OVERDUE", "PARTIALLY_PAID", "PAID", "CANCELLED",
    ];
    for (const k of keys) {
      expect(typeof INVOICE_STATUS_LABEL[k]).toBe("string");
      expect(INVOICE_STATUS_LABEL[k].length).toBeGreaterThan(0);
    }
  });
});
