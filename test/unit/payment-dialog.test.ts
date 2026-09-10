/** Phase 13c, Task 3 (Review-Fund zu Task 3, Task 5) — Strukturtest (kein RTL): der
 *  Zahlungsdialog nutzt dasselbe PaymentForm und dieselbe Route, oeffnet sich ueber den
 *  Anker #zahlung und delegiert den Dialograhmen vollstaendig an `RowPaymentDialog` — kein
 *  zweites eigenes `<dialog>`-Grundgeruest im Projekt. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const dialog = readFileSync(path.join(SRC, "app/rechnungen/[id]/_parts/PaymentDialog.tsx"), "utf8");
const rowDialog = readFileSync(path.join(SRC, "components/list/RowPaymentDialog.tsx"), "utf8");
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

  it("kein eigenes Dialog-Grundgeruest mehr — delegiert an RowPaymentDialog (ein einziger Dialograhmen im Projekt)", () => {
    expect(dialog).not.toMatch(/<dialog\b/);
    expect(dialog).not.toContain("useRef");
    expect(dialog).not.toContain("showModal");
    expect(dialog).not.toContain("backdrop:bg");
    expect(dialog).toContain("RowPaymentDialog");
    // RowPaymentDialog traegt selbst w-full + max-w- (dialogs.test.ts-Regel) — hier nur
    // sicherstellen, dass der gemeinsame Rahmen ueberhaupt noch beide Klassen traegt.
    expect(rowDialog).toMatch(/<dialog[\s\S]{0,400}?w-full[\s\S]{0,200}?max-w-/);
  });

  it("EIN Schliesspfad (close()) fuer Esc/✕ und erfolgreiches Buchen — setzt in beiden Faellen den Hash zurueck", () => {
    // Sowohl RowPaymentDialogs onClose (Esc, ✕) als auch PaymentForms onDone (Buchen)
    // rufen dieselbe close()-Funktion — kein zweiter, hashvergessener Schliesspfad.
    expect(dialog).toMatch(/onClose=\{close\}/);
    expect(dialog).toMatch(/onDone=\{close\}/);
    expect(dialog).toMatch(/function close\(\)[\s\S]{0,400}history\.replaceState/);
  });

  it("die Statuskarte zeigt kein Dauerformular mehr", () => {
    expect(card).not.toContain("<PaymentForm");
    expect(card).toContain("PaymentDialog");
  });
});
