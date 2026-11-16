import { describe, it, expect } from "vitest";
import { FINALIZE_WARNING_CODES, finalizeWarningMessage, parseWarningCodes, warningCodesParam } from "@/domain/invoice/finalize-warnings";
import { KU_NOTICE } from "@/schemas/small-business";

describe("Hinweiscodes beim Festschreiben", () => {
  it("kennt Ausstellfrist und Umsatzgrenze", () => {
    expect(FINALIZE_WARNING_CODES).toContain("ausstellfrist");
    expect(FINALIZE_WARNING_CODES).toContain("ku-grenze");
    expect(parseWarningCodes("ausstellfrist,ku-grenze,unbekannt,ausstellfrist")).toEqual(["ausstellfrist", "ku-grenze"]);
    expect(warningCodesParam([
      { code: "ausstellfrist", message: "a" },
      { code: "ku-grenze", message: "b" },
      { code: "ausstellfrist", message: "c" },
    ])).toBe("ausstellfrist,ku-grenze");
  });
  it("feste Texte ohne Variablen", () => {
    const frist = finalizeWarningMessage("ausstellfrist");
    expect(frist).toContain("§ 14a Abs. 1, 3 UStG");
    expect(finalizeWarningMessage("ausstellfrist", "DE123", "x")).toBe(frist);
    const ku = finalizeWarningMessage("ku-grenze");
    expect(ku).toContain("§ 19 Abs. 1 UStG");
    expect(ku.endsWith(KU_NOTICE)).toBe(true);
    expect(finalizeWarningMessage("ku-grenze", "DE123", "x")).toBe(ku);
  });
});
