/**
 * Sammelrechnung: Zod-Eingabe fuer Abo-Schalter und Blockueberschrift.
 */
import { describe, it, expect } from "vitest";
import { createRecurringSchema, updateRecurringSchema } from "@/schemas";

const base = {
  customerId: "c1",
  title: "Hosting",
  startDate: "2205-01-01",
  lines: [{ description: "Paket", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19 }],
};

function headingIssue(input: unknown): boolean {
  const r = createRecurringSchema.safeParse(input);
  return !r.success && r.error.issues.some((i) => i.path.join(".") === "invoiceHeading");
}

describe("createRecurringSchema Sammelrechnung", () => {
  it("Schalter ohne Ueberschrift -> Fehler am Pfad invoiceHeading", () => {
    expect(headingIssue({ ...base, collectiveBilling: true })).toBe(true);
  });
  it("leere Ueberschrift -> Fehler", () => {
    expect(headingIssue({ ...base, collectiveBilling: true, invoiceHeading: "   " })).toBe(true);
  });
  it("Ueberschrift wird getrimmt", () => {
    const r = createRecurringSchema.parse({ ...base, collectiveBilling: true, invoiceHeading: "  Webhosting  " });
    expect(r.invoiceHeading).toBe("Webhosting");
  });
  it("201 Zeichen -> Fehler, 200 ok", () => {
    expect(headingIssue({ ...base, collectiveBilling: true, invoiceHeading: "x".repeat(201) })).toBe(true);
    expect(createRecurringSchema.safeParse({ ...base, collectiveBilling: true, invoiceHeading: "x".repeat(200) }).success).toBe(true);
  });
  it("Steuerzeichen -> Fehler", () => {
    expect(headingIssue({ ...base, invoiceHeading: "A\nB" })).toBe(true);
  });
  it("Bidi-/Formatzeichen -> Fehler", () => {
    expect(headingIssue({ ...base, invoiceHeading: "A\u202EB" })).toBe(true);
  });
  it("ohne Schalter ist die Ueberschrift optional", () => {
    expect(createRecurringSchema.safeParse(base).success).toBe(true);
    expect(createRecurringSchema.safeParse({ ...base, collectiveBilling: false }).success).toBe(true);
  });
});

describe("updateRecurringSchema Sammelrechnung", () => {
  it("akzeptiert null und Schalter", () => {
    const r = updateRecurringSchema.parse({ collectiveBilling: true, invoiceHeading: null });
    expect(r.invoiceHeading).toBeNull();
    expect(r.collectiveBilling).toBe(true);
  });
  it("trimmt und begrenzt die Ueberschrift", () => {
    expect(updateRecurringSchema.parse({ invoiceHeading: " A " }).invoiceHeading).toBe("A");
    expect(updateRecurringSchema.safeParse({ invoiceHeading: "x".repeat(201) }).success).toBe(false);
  });
});
