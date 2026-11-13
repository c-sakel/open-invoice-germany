import { describe, it, expect } from "vitest";
import { unitLabel, unitCodeFromInput } from "@/lib/units";

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

describe("unitLabel (en)", () => {
  it("englische Kürzel, Default bleibt deutsch, Unbekanntes unverändert", () => {
    expect(unitLabel("HUR", "en")).toBe("h");
    expect(unitLabel("C62", "en")).toBe("pcs");
    expect(unitLabel("H87", "en")).toBe("flat rate");
    expect(unitLabel("C62")).toBe("Stk");
    expect(unitLabel("Kiste", "en")).toBe("Kiste");
  });
});

describe("unitCodeFromInput", () => {
  it("Kürzel, Langform und Code", () => {
    expect(unitCodeFromInput("Std")).toBe("HUR");
    expect(unitCodeFromInput("stück")).toBe("C62");
    expect(unitCodeFromInput("Stunde")).toBe("HUR");
    expect(unitCodeFromInput("m²")).toBe("MTK");
    expect(unitCodeFromInput("Pauschale")).toBe("H87");
    expect(unitCodeFromInput("HUR")).toBe("HUR");
  });
  it("Freitext bleibt, leer wird C62", () => {
    expect(unitCodeFromInput("Palette")).toBe("Palette");
    expect(unitCodeFromInput("")).toBe("C62");
    expect(unitCodeFromInput("  ")).toBe("C62");
  });
});
