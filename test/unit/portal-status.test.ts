/**
 * Oeffentlicher Status der Portalansicht (rein): offen, teilweise, bezahlt, storniert, Gutschrift, ueberfaellig.
 */
import { describe, expect, it } from "vitest";
import { openAmountCents, publicInvoiceStatus, type PublicStatusInput } from "@/domain/portal/view";
import { berlinDateKey } from "@/lib/berlin-time";

const base: PublicStatusInput = {
  type: "INVOICE",
  status: "SENT",
  dueDate: new Date("2195-05-10T00:00:00.000Z"),
  grossTotalCents: 11900,
  payableCents: null,
  paidAmountCents: 0,
};

describe("publicInvoiceStatus", () => {
  it("offen, teilweise bezahlt, bezahlt, storniert", () => {
    expect(publicInvoiceStatus(base, "2195-05-01")).toBe("OPEN");
    expect(publicInvoiceStatus({ ...base, status: "PARTIALLY_PAID", paidAmountCents: 5000 }, "2195-05-01")).toBe("PARTIALLY_PAID");
    expect(publicInvoiceStatus({ ...base, status: "PAID", paidAmountCents: 11900 }, "2195-06-01")).toBe("PAID");
    expect(publicInvoiceStatus({ ...base, status: "CANCELLED" }, "2195-05-01")).toBe("CANCELLED");
  });

  it("ueberfaellig erst am Berliner Folgetag nach dem Faelligkeitsdatum", () => {
    expect(publicInvoiceStatus(base, "2195-05-10")).toBe("OPEN");
    expect(publicInvoiceStatus(base, "2195-05-11")).toBe("OVERDUE");
    // 10.05. 22:30 UTC ist in Berlin bereits der 11.05. (Sommerzeit)
    expect(publicInvoiceStatus(base, berlinDateKey(new Date("2195-05-10T21:30:00.000Z")))).toBe("OPEN");
    expect(publicInvoiceStatus(base, berlinDateKey(new Date("2195-05-10T22:30:00.000Z")))).toBe("OVERDUE");
  });

  it("Gutschrift -> CREDIT mit offen 0", () => {
    const credit = { ...base, type: "CREDIT_NOTE", grossTotalCents: -11900 };
    expect(publicInvoiceStatus(credit, "2196-01-01")).toBe("CREDIT");
    expect(openAmountCents(credit)).toBe(0);
  });

  it("Schlussrechnung nutzt payableCents", () => {
    const final = { ...base, type: "FINAL", grossTotalCents: 11900, payableCents: 4000 };
    expect(openAmountCents(final)).toBe(4000);
    expect(openAmountCents({ ...final, paidAmountCents: 4000 })).toBe(0);
    expect(publicInvoiceStatus({ ...final, status: "PARTIALLY_PAID", paidAmountCents: 4000 }, "2195-05-01")).toBe("PAID");
  });

  it("Ueberzahlung ergibt nie negativen Offenbetrag", () => {
    expect(openAmountCents({ ...base, paidAmountCents: 20000 })).toBe(0);
  });
});
