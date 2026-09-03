import { describe, it, expect } from "vitest";
import {
  OnQuoteAccept,
  documentSettingsSchema,
  shareLinkCreateSchema,
  offerDecisionSchema,
} from "@/schemas";

describe("OnQuoteAccept", () => {
  it("akzeptiert NONE/ORDER_CONFIRMATION/INVOICE", () => {
    for (const v of ["NONE", "ORDER_CONFIRMATION", "INVOICE"]) {
      expect(OnQuoteAccept.safeParse(v).success).toBe(true);
    }
    expect(OnQuoteAccept.safeParse("SONSTIGES").success).toBe(false);
  });
});

describe("documentSettingsSchema", () => {
  it("setzt Defaults bei leerem Objekt", () => {
    const parsed = documentSettingsSchema.parse({});
    expect(parsed).toEqual({ onQuoteAccept: "NONE", shareLinkDays: 30, storeAcceptIp: false });
  });

  it("lehnt shareLinkDays ausserhalb 1..365 ab", () => {
    expect(documentSettingsSchema.safeParse({ shareLinkDays: 0 }).success).toBe(false);
    expect(documentSettingsSchema.safeParse({ shareLinkDays: 366 }).success).toBe(false);
    expect(documentSettingsSchema.safeParse({ shareLinkDays: 365 }).success).toBe(true);
  });
});

describe("shareLinkCreateSchema", () => {
  it("expiresInDays ist optional", () => {
    expect(shareLinkCreateSchema.parse({})).toEqual({});
  });

  it("lehnt Werte ausserhalb 1..365 ab", () => {
    expect(shareLinkCreateSchema.safeParse({ expiresInDays: 0 }).success).toBe(false);
    expect(shareLinkCreateSchema.safeParse({ expiresInDays: 90 }).success).toBe(true);
  });
});

describe("offerDecisionSchema", () => {
  it("verlangt einen Namen mit mindestens 2 Zeichen", () => {
    expect(offerDecisionSchema.safeParse({ decision: "ACCEPTED", name: "A" }).success).toBe(false);
    expect(offerDecisionSchema.safeParse({ decision: "ACCEPTED", name: "Ab" }).success).toBe(true);
  });

  it("erlaubt E-Mail optional und als leeren String", () => {
    expect(offerDecisionSchema.safeParse({ decision: "ACCEPTED", name: "Max Muster" }).success).toBe(true);
    expect(
      offerDecisionSchema.safeParse({ decision: "ACCEPTED", name: "Max Muster", email: "" }).success,
    ).toBe(true);
    expect(
      offerDecisionSchema.safeParse({ decision: "ACCEPTED", name: "Max Muster", email: "max@example.com" })
        .success,
    ).toBe(true);
    expect(
      offerDecisionSchema.safeParse({ decision: "ACCEPTED", name: "Max Muster", email: "keine-email" })
        .success,
    ).toBe(false);
  });

  it("begrenzt den Kommentar auf 2000 Zeichen", () => {
    const ok = offerDecisionSchema.safeParse({
      decision: "REJECTED",
      name: "Max Muster",
      comment: "x".repeat(2000),
    });
    expect(ok.success).toBe(true);

    const zuLang = offerDecisionSchema.safeParse({
      decision: "REJECTED",
      name: "Max Muster",
      comment: "x".repeat(2001),
    });
    expect(zuLang.success).toBe(false);
  });

  it("lehnt eine unbekannte decision ab", () => {
    expect(offerDecisionSchema.safeParse({ decision: "MAYBE", name: "Max Muster" }).success).toBe(false);
  });
});
