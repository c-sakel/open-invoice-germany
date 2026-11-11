import { describe, it, expect } from "vitest";
import { layoutDesignConfigSchema, contrastWarnings, DEFAULT_COLUMNS, type LayoutDesignConfig } from "@/schemas/layout-design";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { dinWindowViolations } from "@/lib/pdf/din5008";
import { contrastRatio } from "@/lib/color/contrast";

function base(): LayoutDesignConfig {
  return structuredClone(presetConfig("standard"));
}

function issues(input: unknown): { path: string; message: string }[] {
  const r = layoutDesignConfigSchema.safeParse(input);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function expectIssue(input: unknown, path: string, fragment: string) {
  const found = issues(input);
  expect(found.some((i) => i.path === path && i.message.includes(fragment)), JSON.stringify(found)).toBe(true);
}

describe("layoutDesignConfigSchema", () => {
  it("akzeptiert die Standardvorlage", () => {
    expect(layoutDesignConfigSchema.safeParse(base()).success).toBe(true);
  });

  it("Bloecke: doppelt", () => {
    const c = base();
    c.blocks = [...c.blocks, "outro"];
    expectIssue(c, "blocks", "nur einmal");
  });
  it("Bloecke: Pflichtbloecke fehlen", () => {
    for (const k of ["lines", "payment"] as const) {
      const c = base();
      c.blocks = c.blocks.filter((b) => b !== k);
      expectIssue(c, "blocks", `Pflichtblock fehlt: ${k}`);
    }
  });
  it("Bloecke: meta an Position 4", () => {
    const c = base();
    c.blocks = ["sender", "recipient", "subject", "meta", "intro", "lines", "totals", "outro", "payment"];
    expectIssue(c, "blocks", "Kopf nach DIN 5008: Absender, Empfänger und Belegdaten stehen fest oben.");
  });
  it("Bloecke: intro nach lines", () => {
    const c = base();
    c.blocks = ["sender", "recipient", "meta", "subject", "lines", "intro", "totals", "outro", "payment"];
    expectIssue(c, "blocks", "direkt nach den Belegdaten");
  });
  it("Bloecke: subject nach intro", () => {
    const c = base();
    c.blocks = ["sender", "recipient", "meta", "intro", "subject", "lines", "totals", "outro", "payment"];
    expectIssue(c, "blocks", "Betreff steht vor der Einleitung");
  });
  it("Bloecke: totals vor lines", () => {
    const c = base();
    c.blocks = ["sender", "recipient", "meta", "subject", "intro", "totals", "lines", "outro", "payment"];
    expectIssue(c, "blocks", "Positionen stehen vor den Summen");
  });
  it("Bloecke: giro vor totals", () => {
    const c = base();
    c.blocks = ["sender", "recipient", "meta", "subject", "intro", "lines", "giro", "totals", "outro", "payment"];
    expectIssue(c, "blocks", "GiroCode steht nach den Summen");
  });
  it("Bloecke: giro nach totals gueltig", () => {
    const c = base();
    c.blocks = ["sender", "recipient", "meta", "lines", "totals", "giro", "payment"];
    expect(issues(c)).toEqual([]);
  });

  it("Spalten: total fehlt", () => {
    const c = base();
    c.columns = c.columns.filter((x) => x.key !== "total");
    c.columns[0].widthPct += 16;
    expectIssue(c, "columns", "Pflichtspalte fehlt: total");
  });
  it("Spalten: Summe 99", () => {
    const c = base();
    c.columns[0].widthPct = 5;
    expectIssue(c, "columns", "Spaltenbreiten ergeben 99 % — benötigt sind 100 %.");
  });
  it("Spalten: description 19", () => {
    const c = base();
    c.columns[2].widthPct = 19;
    c.columns[0].widthPct += 19;
    expectIssue(c, "columns.2.widthPct", "mindestens 20 %");
  });
  it("Spalten: doppelt", () => {
    const c = base();
    c.columns = [...c.columns.slice(0, 6), { key: "pos", widthPct: 16 }];
    expectIssue(c, "columns", "nur einmal");
  });
  it("Spalten: alle neun mit Summe 100 gueltig", () => {
    const c = base();
    const widths = [5, 8, 30, 8, 8, 12, 8, 7, 14];
    const keys = ["pos", "article", "description", "qty", "unit", "unitPrice", "taxRate", "discount", "total"] as const;
    c.columns = keys.map((key, i) => ({ key, widthPct: widths[i] }));
    expect(widths.reduce((a, b) => a + b, 0)).toBe(100);
    expect(issues(c)).toEqual([]);
  });

  it("Schriftgroesse", () => {
    for (const v of [12.5, 7.5, 9.3]) {
      const c = base();
      c.fontSizePt = v;
      expect(issues(c).some((i) => i.path === "fontSizePt")).toBe(true);
    }
  });
  it("Farbe #fff abgelehnt", () => {
    const c = base();
    c.colors.primary = "#fff";
    expectIssue(c, "colors.primary", "#rrggbb");
  });
  it("Rand links 19", () => {
    const c = base();
    c.marginsMm.left = 19;
    expect(issues(c).some((i) => i.path === "marginsMm.left")).toBe(true);
  });
  it("Kopfzone ragt ins Anschriftfeld", () => {
    const c = base();
    c.marginsMm.top = 20;
    c.header.heightMm = 26;
    expectIssue(c, "header.heightMm", "Kopfzone endet bei 46 mm und ragt in das Anschriftfeld (ab 45 mm, DIN 5008 Form B).");
  });
  it("Kopfzone genau 45 mm gueltig", () => {
    const c = base();
    c.marginsMm.top = 10;
    c.header.heightMm = 35;
    expect(issues(c)).toEqual([]);
  });
  it("unbekannter Schluessel (strict)", () => {
    expect(layoutDesignConfigSchema.safeParse({ ...base(), foo: 1 }).success).toBe(false);
    const c = base() as unknown as { logo: Record<string, unknown> };
    c.logo.foo = 1;
    expect(layoutDesignConfigSchema.safeParse(c).success).toBe(false);
  });
  it("DEFAULT_COLUMNS summieren 100", () => {
    expect(DEFAULT_COLUMNS.reduce((s, c) => s + c.widthPct, 0)).toBe(100);
  });
});

describe("dinWindowViolations", () => {
  it("innerhalb des Fensters", () => {
    expect(dinWindowViolations({ xMm: 25, yMm: 62.7, widthMm: 80, heightMm: 27.3 })).toEqual([]);
  });
  it("zu weit oben, links, rechts, unten", () => {
    expect(dinWindowViolations({ xMm: 25, yMm: 44, widthMm: 80, heightMm: 20 })).toHaveLength(1);
    expect(dinWindowViolations({ xMm: 19, yMm: 50, widthMm: 80, heightMm: 20 })).toHaveLength(1);
    expect(dinWindowViolations({ xMm: 25, yMm: 50, widthMm: 81, heightMm: 20 })).toHaveLength(1);
    expect(dinWindowViolations({ xMm: 25, yMm: 50, widthMm: 80, heightMm: 41 })).toHaveLength(1);
  });
});

describe("Kontrast", () => {
  it("Schwarz auf Weiss ist 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
  it("Warnungen fuer helle Schrift", () => {
    const c = base().colors;
    expect(contrastWarnings({ ...c, text: "#cccccc" }).map((w) => w.key)).toContain("text");
    expect(contrastWarnings({ ...c, text: "#333333" }).map((w) => w.key)).not.toContain("text");
  });
});
