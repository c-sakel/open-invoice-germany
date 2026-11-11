import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge, BillingStateBadge, statusTone } from "@/components/StatusBadge";
import { QuoteStatus, DeliveryNoteStatus, DunningState } from "@/schemas";
import { INVOICE_STATUS_LABEL } from "@/domain/invoice/status";

const KEYS = [
  "DRAFT", "FINALIZED", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED", "ACCEPTED", "REJECTED", "EXPIRED", "CREATED",
  "DELIVERED", "OPEN", "DUE", "OVERDUE", "ARCHIVED", "ACTIVE", "PAUSED", "ENDED", "STOPPED",
];
const TONES = ["neutral", "pen", "seal", "stamp", "ledger"];
const OLD_PALETTE = /(slate|indigo|sky|amber|emerald|rose)-\d/;

describe("StatusBadge", () => {
  it("jeder bekannte Status hat Ton und Text", () => {
    expect(KEYS).toHaveLength(19);
    for (const key of [...KEYS, "UNBEKANNT"]) {
      expect(TONES).toContain(statusTone(key));
      const html = renderToStaticMarkup(<StatusBadge status={key} />);
      const text = html.replace(/<[^>]+>/g, "").trim();
      expect(text.length).toBeGreaterThan(0);
      expect(html).not.toMatch(OLD_PALETTE);
    }
    for (const state of ["NONE", "PARTIAL", "FULL"]) {
      expect(renderToStaticMarkup(<BillingStateBadge state={state} />)).not.toMatch(OLD_PALETTE);
    }
  });

  it("kein real vorkommender Status erscheint als roher Enum-Wert", () => {
    const real = new Set<string>([
      ...QuoteStatus.options,
      ...DeliveryNoteStatus.options,
      ...DunningState.options,
      ...Object.keys(INVOICE_STATUS_LABEL),
      "SENT", "ACTIVE", "PAUSED", "ENDED", "ARCHIVED",
    ]);
    for (const key of real) {
      const text = renderToStaticMarkup(<StatusBadge status={key} />).replace(/<[^>]+>/g, "").trim();
      expect(text, key).not.toBe(key);
      expect(text, key).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it("ordnet die Kernstatus ihren Tönen zu", () => {
    expect(statusTone("OVERDUE")).toBe("stamp");
    expect(statusTone("PAID")).toBe("ledger");
    expect(statusTone("DUE")).toBe("seal");
    expect(statusTone("SENT")).toBe("pen");
    expect(statusTone("DRAFT")).toBe("neutral");
  });

  it("partiallyPaid hängt \"· teilbezahlt\" an", () => {
    expect(renderToStaticMarkup(<StatusBadge status="OPEN" partiallyPaid />)).toContain("Offen · teilbezahlt");
    expect(renderToStaticMarkup(<StatusBadge status="PARTIALLY_PAID" partiallyPaid />)).not.toContain("· teilbezahlt");
  });
});
