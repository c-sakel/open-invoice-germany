/** Phase 13d, Task 2 — Zod-Schemas fuer Tags (src/schemas/tag.ts). */
import { describe, it, expect } from "vitest";
import { TagColor, TagDocType, tagInputSchema, tagAssignSchema } from "@/schemas/tag";

describe("TagColor", () => {
  it("akzeptiert genau die acht definierten Farben", () => {
    for (const c of ["slate", "rose", "amber", "emerald", "sky", "indigo", "violet", "stone"]) {
      expect(TagColor.safeParse(c).success).toBe(true);
    }
  });
  it("lehnt einen freien Hex-Code oder unbekannte Werte ab", () => {
    expect(TagColor.safeParse("#ff0000").success).toBe(false);
    expect(TagColor.safeParse("blue").success).toBe(false);
  });
});

describe("TagDocType", () => {
  it("akzeptiert INVOICE/QUOTE/DELIVERY_NOTE", () => {
    for (const t of ["INVOICE", "QUOTE", "DELIVERY_NOTE"]) {
      expect(TagDocType.safeParse(t).success).toBe(true);
    }
  });
  it("lehnt RECURRING/DUNNING ab (Tags sind auf Belege mit eigener Detailansicht beschraenkt)", () => {
    expect(TagDocType.safeParse("RECURRING").success).toBe(false);
    expect(TagDocType.safeParse("DUNNING").success).toBe(false);
  });
});

describe("tagInputSchema", () => {
  it("trimmt den Namen, Farbe faellt auf slate zurueck", () => {
    const v = tagInputSchema.parse({ name: "  Wartung  " });
    expect(v).toEqual({ name: "Wartung", color: "slate" });
  });

  it("lehnt einen leeren oder rein aus Leerzeichen bestehenden Namen ab", () => {
    expect(tagInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(tagInputSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("deckelt den Namen auf 40 Zeichen", () => {
    expect(tagInputSchema.safeParse({ name: "a".repeat(40) }).success).toBe(true);
    expect(tagInputSchema.safeParse({ name: "a".repeat(41) }).success).toBe(false);
  });

  it("uebernimmt eine explizite Farbe", () => {
    expect(tagInputSchema.parse({ name: "Dringend", color: "rose" })).toEqual({ name: "Dringend", color: "rose" });
  });
});

describe("tagAssignSchema", () => {
  it("verlangt docType und eine nichtleere docId", () => {
    expect(tagAssignSchema.safeParse({ docType: "INVOICE", docId: "abc" }).success).toBe(true);
    expect(tagAssignSchema.safeParse({ docType: "INVOICE", docId: "" }).success).toBe(false);
    expect(tagAssignSchema.safeParse({ docType: "CUSTOMER", docId: "abc" }).success).toBe(false);
    expect(tagAssignSchema.safeParse({ docId: "abc" }).success).toBe(false);
  });
});
