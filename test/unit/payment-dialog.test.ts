/** Phase 13c, Task 3 — Strukturtest (kein RTL): der Zahlungsdialog nutzt dasselbe
 *  PaymentForm und dieselbe Route, oeffnet sich ueber den Anker #zahlung und traegt die
 *  Breitenklassen, die die Phase-12a-Dialogregel verlangt. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const dialog = readFileSync(path.join(SRC, "app/rechnungen/[id]/_parts/PaymentDialog.tsx"), "utf8");
const card = readFileSync(path.join(SRC, "app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx"), "utf8");
const form = readFileSync(path.join(SRC, "components/PaymentForm.tsx"), "utf8");

describe("Zahlungsdialog (Phase 13c)", () => {
  it("bettet das unveraenderte PaymentForm ein — keine eigene Buchungslogik", () => {
    expect(dialog).toContain("PaymentForm");
    expect(dialog).not.toMatch(/fetch\(/);
    expect(form).toMatch(/\/api\/invoices\/\$\{invoiceId\}\/payment/);
  });

  it("der Anker #zahlung oeffnet den Dialog (Bestandslinks aus Liste und Mahnwesen)", () => {
    expect(dialog).toContain("hashchange");
    expect(dialog).toContain('id="zahlung"');
  });

  it("traegt w-full und eine max-w-Klasse (dialogs.test.ts-Regel)", () => {
    expect(dialog).toMatch(/<dialog[\s\S]{0,400}?w-full[\s\S]{0,200}?max-w-/);
  });

  it("die Statuskarte zeigt kein Dauerformular mehr", () => {
    expect(card).not.toContain("<PaymentForm");
    expect(card).toContain("PaymentDialog");
  });
});
