import { describe, it, expect } from "vitest";
import { COUNTRY_CODES, countryOptions } from "@/lib/countries";

describe("Laenderauswahl", () => {
  it("bietet keinen Code an, den die E-Rechnungs-Codeliste nicht kennt (XK)", () => {
    expect(COUNTRY_CODES).not.toContain("XK");
    expect(countryOptions().some((o) => o.id === "XK")).toBe(false);
  });
});
