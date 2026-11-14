import { describe, it, expect } from "vitest";
import { normalizeCreditorId, isValidCreditorId, isValidMandateReference } from "@/lib/sepa";

describe("Gläubiger-ID", () => {
  it.each(["DE98ZZZ09999999999", "DE98ABC09999999999", "DE79ZZZ01234567890", "AT61ZZZ01234567890"])("gültig %s", (ci) => {
    expect(isValidCreditorId(ci)).toBe(true);
  });
  it("normalisiert Leerzeichen und Kleinschreibung", () => {
    const n = normalizeCreditorId("de98 zzz 0999 9999 999");
    expect(n).toBe("DE98ZZZ09999999999");
    expect(isValidCreditorId(n)).toBe(true);
  });
  it.each(["DE97ZZZ09999999999", "DE98ZZZ0999999999", "DE98ZZZ0999999999A", "XX", "AT61ZZZ" + "0".repeat(29)])("ungültig %s", (ci) => {
    expect(isValidCreditorId(ci)).toBe(false);
  });
});

describe("Mandatsreferenz", () => {
  it("akzeptiert zulässige Zeichen", () => expect(isValidMandateReference("MANDAT-2180-001")).toBe(true));
  it.each(["M 1", "Ä1", "A".repeat(36), ""])("lehnt %j ab", (r) => expect(isValidMandateReference(r)).toBe(false));
});
