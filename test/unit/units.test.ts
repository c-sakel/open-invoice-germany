import { describe, it, expect } from "vitest";
import { unitLabel } from "@/lib/units";

describe("unitLabel", () => {
  it("mappt alle bekannten UN/ECE-Codes auf ihren Klarnamen", () => {
    expect(unitLabel("C62")).toBe("Stk");
    expect(unitLabel("HUR")).toBe("Std");
    expect(unitLabel("DAY")).toBe("Tag");
    expect(unitLabel("KGM")).toBe("kg");
    expect(unitLabel("MTR")).toBe("m");
    expect(unitLabel("LTR")).toBe("l");
    expect(unitLabel("MTK")).toBe("m²");
    expect(unitLabel("H87")).toBe("Pauschale");
  });

  it("gibt unbekannte Codes unveraendert zurueck (Freitext-Einheiten)", () => {
    expect(unitLabel("XYZ")).toBe("XYZ");
    expect(unitLabel("Kiste")).toBe("Kiste");
  });

  it("liefert bei leerer Eingabe eine leere Zeichenkette", () => {
    expect(unitLabel("")).toBe("");
  });
});
