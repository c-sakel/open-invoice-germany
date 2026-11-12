import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKS, DEFAULT_COLUMNS, layoutDesignConfigSchema } from "@/schemas/layout-design";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { collectFieldErrors, columnSum, moveBlock, moveColumn, OPTIONAL_BLOCKS, toggleBlock, toggleColumn } from "@/lib/layout-design/editor";

describe("moveBlock", () => {
  it("setzt den Fusstext vor die Summen, Ergebnis ist gueltig", () => {
    const next = moveBlock(DEFAULT_BLOCKS, "outro", 6);
    expect(next.indexOf("outro")).toBe(next.indexOf("totals") - 1);
    expect(layoutDesignConfigSchema.safeParse({ ...presetConfig("standard"), blocks: next }).success).toBe(true);
  });

  it("klemmt Ziele im Kopfbereich auf Index 3", () => {
    const next = moveBlock(DEFAULT_BLOCKS, "lines", 0);
    expect(next.indexOf("lines")).toBe(3);
    expect(next.slice(0, 3)).toEqual(["sender", "recipient", "meta"]);
  });

  it("laesst Kopfbloecke unbeweglich", () => {
    expect(moveBlock(DEFAULT_BLOCKS, "sender", 5)).toEqual([...DEFAULT_BLOCKS]);
  });
});

describe("toggleBlock", () => {
  it("lehnt Pflichtbloecke ab", () => {
    expect(toggleBlock(DEFAULT_BLOCKS, "payment")).toEqual([...DEFAULT_BLOCKS]);
    expect(toggleBlock(DEFAULT_BLOCKS, "lines")).toEqual([...DEFAULT_BLOCKS]);
  });

  it("fuegt giro direkt nach totals ein und entfernt ihn wieder", () => {
    const withGiro = toggleBlock(DEFAULT_BLOCKS, "giro");
    expect(withGiro.indexOf("giro")).toBe(withGiro.indexOf("totals") + 1);
    expect(toggleBlock(withGiro, "giro")).toEqual([...DEFAULT_BLOCKS]);
  });

  it("Betreff, Einleitung und Fusstext lassen sich nicht ausblenden (nur Reihenfolge)", () => {
    for (const key of ["subject", "intro", "outro"] as const) {
      expect(toggleBlock(DEFAULT_BLOCKS, key)).toEqual([...DEFAULT_BLOCKS]);
    }
    expect(OPTIONAL_BLOCKS).toEqual(["giro"]);
    expect(layoutDesignConfigSchema.safeParse({ ...presetConfig("standard"), blocks: [...DEFAULT_BLOCKS] }).success).toBe(true);
  });
});

describe("Spalten", () => {
  it("schaltet Artikelnummer aus: Summe 100, Beschreibung 48", () => {
    const next = toggleColumn(DEFAULT_COLUMNS, "article");
    expect(columnSum(next)).toBe(100);
    expect(next.find((c) => c.key === "description")?.widthPct).toBe(48);
    expect(next.some((c) => c.key === "article")).toBe(false);
  });

  it("schaltet sie wieder ein und stellt die Ausgangsbreiten her", () => {
    const back = toggleColumn(toggleColumn(DEFAULT_COLUMNS, "article"), "article");
    expect(back).toEqual(DEFAULT_COLUMNS);
  });

  it("laesst Pflichtspalten unveraendert", () => {
    expect(toggleColumn(DEFAULT_COLUMNS, "total")).toEqual(DEFAULT_COLUMNS);
    expect(toggleColumn(DEFAULT_COLUMNS, "description")).toEqual(DEFAULT_COLUMNS);
  });

  it("fuegt Einheit an der kanonischen Stelle ein und haelt Summe und Mindestbreite", () => {
    const next = toggleColumn(DEFAULT_COLUMNS, "unit");
    expect(next.map((c) => c.key).indexOf("unit")).toBe(next.map((c) => c.key).indexOf("qty") + 1);
    expect(columnSum(next)).toBe(100);
    expect(next.find((c) => c.key === "description")!.widthPct).toBeGreaterThanOrEqual(20);
  });

  it("verweigert das Einschalten, wenn die Beschreibung sonst unter 20 % faellt", () => {
    const tight = DEFAULT_COLUMNS.map((c) => (c.key === "description" ? { ...c, widthPct: 22 } : c));
    expect(toggleColumn(tight, "unit")).toEqual(tight);
  });

  it("verschiebt Spalten und klemmt am Rand", () => {
    const up = moveColumn(DEFAULT_COLUMNS, "article", "up");
    expect(up[0]!.key).toBe("article");
    expect(moveColumn(DEFAULT_COLUMNS, "pos", "up")).toEqual(DEFAULT_COLUMNS);
    expect(moveColumn(DEFAULT_COLUMNS, "total", "down")).toEqual(DEFAULT_COLUMNS);
  });
});

describe("collectFieldErrors", () => {
  it("gruppiert Schemafehler je Feldpfad", () => {
    const bad = { ...presetConfig("standard"), columns: DEFAULT_COLUMNS.map((c) => (c.key === "description" ? { ...c, widthPct: 37 } : c)) };
    const result = layoutDesignConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(collectFieldErrors(result.error.issues).columns).toEqual(["Spaltenbreiten ergeben 99 % — benötigt sind 100 %."]);
  });
});
