/** Phase 13c, Task 4 — Primaeraktion je Status als reine Tabelle (kein DB-Zugriff). */
import { describe, it, expect } from "vitest";
import { primaryAction } from "@/app/rechnungen/[id]/_parts/invoice-view-model";

const base = { isDraft: false, isCancelled: false, canPay: false, isInvoiceType: true };

describe("primaryAction", () => {
  it("Entwurf -> Festschreiben (schlaegt alles andere)", () => {
    expect(primaryAction({ ...base, isDraft: true })).toEqual({ kind: "FINALIZE", label: "Festschreiben" });
    expect(primaryAction({ isDraft: true, isCancelled: true, canPay: true, isInvoiceType: true }).kind).toBe("FINALIZE");
  });
  it("festgeschrieben/versendet/teilbezahlt (offen) -> Als bezahlt markieren", () => {
    expect(primaryAction({ ...base, canPay: true })).toEqual({ kind: "PAY", label: "Als bezahlt markieren" });
  });
  it("bezahlt -> Neue Rechnung", () => {
    expect(primaryAction(base)).toEqual({ kind: "NEW_INVOICE", label: "Neue Rechnung" });
  });
  it("storniert und Gutschrift -> Neue Rechnung, nie Zahlung", () => {
    expect(primaryAction({ ...base, isCancelled: true, canPay: true }).kind).toBe("NEW_INVOICE");
    expect(primaryAction({ ...base, isInvoiceType: false, canPay: true }).kind).toBe("NEW_INVOICE");
  });
});
