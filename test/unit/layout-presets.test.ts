import { describe, it, expect } from "vitest";
import { LAYOUT_IDS } from "@/lib/pdf/layouts/ids";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { canonicalConfigJson, configHash } from "@/lib/pdf/layouts/config-hash";
import { layoutDesignConfigSchema } from "@/schemas/layout-design";

describe("presetConfig", () => {
  it.each(LAYOUT_IDS)("%s ist gueltig", (id) => {
    const r = layoutDesignConfigSchema.safeParse(presetConfig(id));
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
  it("giro nur bei schlicht, direkt nach totals", () => {
    const b = presetConfig("schlicht").blocks;
    expect(b[b.indexOf("totals") + 1]).toBe("giro");
    expect(presetConfig("standard").blocks).not.toContain("giro");
  });
  it("kompakt 9 pt", () => {
    expect(presetConfig("kompakt").fontSizePt).toBe(9);
  });
});

describe("configHash", () => {
  it("stabil und reihenfolgeunabhaengig", () => {
    const c = presetConfig("klassik");
    expect(configHash(c)).toBe(configHash(c));
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(c).reverse())));
    reordered.colors = Object.fromEntries(Object.entries(c.colors).reverse());
    expect(canonicalConfigJson(reordered)).toBe(canonicalConfigJson(c));
    expect(configHash(reordered)).toBe(configHash(c));
  });
  it("andere Farbe, anderer Hash", () => {
    const c = presetConfig("klassik");
    expect(configHash({ ...c, colors: { ...c.colors, primary: "#123456" } })).not.toBe(configHash(c));
  });
});
