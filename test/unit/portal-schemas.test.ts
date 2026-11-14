import { describe, expect, it } from "vitest";
import { createPortalLinkInputSchema, portalSettingsInputSchema, portalTokenSchema } from "@/schemas/portal";
import { generateToken } from "@/domain/portal/token";

describe("Portal-Schemas", () => {
  it("linkDays 1..730", () => {
    expect(portalSettingsInputSchema.safeParse({ linkDays: 0 }).success).toBe(false);
    expect(portalSettingsInputSchema.safeParse({ linkDays: 731 }).success).toBe(false);
    expect(portalSettingsInputSchema.safeParse({ linkDays: 1 }).success).toBe(true);
    expect(portalSettingsInputSchema.safeParse({ linkDays: 730 }).success).toBe(true);
    expect(portalSettingsInputSchema.safeParse({ linkDays: 1.5 }).success).toBe(false);
  });

  it("Teil-Update erlaubt leeres Objekt, Texte werden begrenzt", () => {
    expect(portalSettingsInputSchema.parse({})).toEqual({});
    expect(portalSettingsInputSchema.safeParse({ mailSubject: "x".repeat(201) }).success).toBe(false);
    expect(portalSettingsInputSchema.safeParse({ mailBody: "x".repeat(5001) }).success).toBe(false);
    expect(portalSettingsInputSchema.parse({ mailSubject: "  Hallo  " }).mailSubject).toBe("Hallo");
    expect(portalSettingsInputSchema.safeParse({ mailBody: null }).success).toBe(true);
  });

  it("expiresInDays 1..730", () => {
    expect(createPortalLinkInputSchema.safeParse({}).success).toBe(true);
    expect(createPortalLinkInputSchema.safeParse({ expiresInDays: 0 }).success).toBe(false);
    expect(createPortalLinkInputSchema.safeParse({ expiresInDays: 731 }).success).toBe(false);
  });

  it("Token: genau 43 base64url-Zeichen", () => {
    expect(portalTokenSchema.safeParse(generateToken()).success).toBe(true);
    expect(portalTokenSchema.safeParse("a".repeat(42)).success).toBe(false);
    expect(portalTokenSchema.safeParse("a".repeat(44)).success).toBe(false);
    expect(portalTokenSchema.safeParse(`${"a".repeat(42)}+`).success).toBe(false);
    expect(portalTokenSchema.safeParse(`${"a".repeat(42)}/`).success).toBe(false);
  });
});
