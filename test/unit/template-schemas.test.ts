/** Phase 13d, Task 3 — Zod-Schemas fuer Belegvorlagen (src/schemas/template.ts). */
import { describe, it, expect } from "vitest";
import {
  documentTemplatePayloadSchema,
  documentTemplateInputSchema,
  saveTemplateFromDocumentSchema,
  applyTemplateSchema,
} from "@/schemas/template";

const line = { description: "Beratung", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 };

describe("documentTemplatePayloadSchema", () => {
  it("akzeptiert einen minimalen Payload (nur Positionen)", () => {
    const v = documentTemplatePayloadSchema.parse({ lines: [line] });
    expect(v.lines).toHaveLength(1);
    // invoiceLineInputSchema-Defaults greifen (lineType ITEM, taxCategory S, discount* 0).
    expect(v.lines[0]).toMatchObject({ lineType: "ITEM", taxCategory: "S", discountPermille: 0, discountCents: 0 });
  });

  it("verlangt mindestens eine Position", () => {
    expect(documentTemplatePayloadSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(documentTemplatePayloadSchema.safeParse({}).success).toBe(false);
  });

  it("lehnt interne Notizen als Vorlagenfeld ab (§48, .strict())", () => {
    expect(documentTemplatePayloadSchema.safeParse({ lines: [line], internalNotes: "geheim" }).success).toBe(false);
  });

  it("lehnt Belegnummer, Datum und Snapshots als Vorlagenfeld ab (.strict())", () => {
    for (const extra of [
      { number: "R-2090-0001" },
      { issueDate: "2090-01-01" },
      { dueDate: "2090-01-15" },
      { validUntil: "2090-02-01" },
      { sellerSnapshotJson: "{}" },
      { buyerSnapshotJson: "{}" },
      { payments: [] },
    ]) {
      expect(documentTemplatePayloadSchema.safeParse({ lines: [line], ...extra }).success).toBe(false);
    }
  });

  it("akzeptiert Rabatt/Aufschlag/Skonto innerhalb ihrer Grenzen", () => {
    const v = documentTemplatePayloadSchema.parse({
      lines: [line],
      documentDiscountPermille: 100,
      documentDiscountCents: 500,
      documentChargePermille: 50,
      documentChargeCents: 0,
      documentChargeReason: "Express",
      skonto1Permille: 20,
      skonto1Days: 10,
      skonto2Permille: 10,
      skonto2Days: 30,
    });
    expect(v.skonto1Permille).toBe(20);
  });

  it("lehnt einen Rabatt-Promille ausserhalb 0..1000 ab", () => {
    expect(documentTemplatePayloadSchema.safeParse({ lines: [line], documentDiscountPermille: 1001 }).success).toBe(false);
    expect(documentTemplatePayloadSchema.safeParse({ lines: [line], documentDiscountPermille: -1 }).success).toBe(false);
  });
});

describe("documentTemplateInputSchema", () => {
  it("verlangt einen nichtleeren Namen (max. 80 Zeichen) und einen gueltigen docType", () => {
    const v = documentTemplateInputSchema.parse({ name: "  Wartung  ", docType: "INVOICE", payload: { lines: [line] } });
    expect(v.name).toBe("Wartung");
    expect(documentTemplateInputSchema.safeParse({ name: "", docType: "INVOICE", payload: { lines: [line] } }).success).toBe(false);
    expect(documentTemplateInputSchema.safeParse({ name: "a".repeat(81), docType: "INVOICE", payload: { lines: [line] } }).success).toBe(false);
    expect(documentTemplateInputSchema.safeParse({ name: "X", docType: "RECURRING", payload: { lines: [line] } }).success).toBe(false);
  });

  it("kind ist nur fuer QUOTE-Vorlagen sinnvoll, wird aber nicht docType-abhaengig erzwungen", () => {
    expect(
      documentTemplateInputSchema.safeParse({ name: "X", docType: "QUOTE", kind: "PROFORMA", payload: { lines: [line] } }).success,
    ).toBe(true);
    expect(
      documentTemplateInputSchema.safeParse({ name: "X", docType: "QUOTE", kind: "UNBEKANNT", payload: { lines: [line] } }).success,
    ).toBe(false);
  });
});

describe("saveTemplateFromDocumentSchema", () => {
  it("verlangt docType, eine nichtleere docId und einen nichtleeren Namen", () => {
    expect(saveTemplateFromDocumentSchema.safeParse({ docType: "INVOICE", docId: "abc", name: "Wartung" }).success).toBe(true);
    expect(saveTemplateFromDocumentSchema.safeParse({ docType: "INVOICE", docId: "", name: "Wartung" }).success).toBe(false);
    expect(saveTemplateFromDocumentSchema.safeParse({ docType: "INVOICE", docId: "abc", name: "" }).success).toBe(false);
    expect(saveTemplateFromDocumentSchema.safeParse({ docType: "CUSTOMER", docId: "abc", name: "Wartung" }).success).toBe(false);
  });
});

describe("applyTemplateSchema", () => {
  it("customerId ist optional, eine leere Zeichenkette wird abgelehnt", () => {
    expect(applyTemplateSchema.parse({})).toEqual({});
    expect(applyTemplateSchema.safeParse({ customerId: "" }).success).toBe(false);
    expect(applyTemplateSchema.parse({ customerId: "abc" })).toEqual({ customerId: "abc" });
  });
});
