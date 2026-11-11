import { z } from "zod";
import { PDF_FONT_FAMILIES, type PdfFontFamily } from "@/lib/pdf/font-families";
import { contrastRatio } from "@/lib/color/contrast";

export const LAYOUT_BLOCK_KEYS = ["sender", "recipient", "meta", "subject", "intro", "lines", "totals", "giro", "outro", "payment"] as const;
export const LAYOUT_COLUMN_KEYS = ["pos", "article", "description", "qty", "unit", "unitPrice", "taxRate", "discount", "total"] as const;
export type LayoutBlockKey = (typeof LAYOUT_BLOCK_KEYS)[number];
export type LayoutColumnKey = (typeof LAYOUT_COLUMN_KEYS)[number];

export const DEFAULT_BLOCKS: readonly LayoutBlockKey[] = ["sender", "recipient", "meta", "subject", "intro", "lines", "totals", "outro", "payment"];
export const DEFAULT_COLUMNS: { key: LayoutColumnKey; widthPct: number }[] = [
  { key: "pos", widthPct: 6 },
  { key: "article", widthPct: 10 },
  { key: "description", widthPct: 38 },
  { key: "qty", widthPct: 10 },
  { key: "unitPrice", widthPct: 13 },
  { key: "taxRate", widthPct: 7 },
  { key: "total", widthPct: 16 },
];

export type LayoutDesignConfig = {
  version: 1;
  blocks: LayoutBlockKey[];
  columns: { key: LayoutColumnKey; widthPct: number }[];
  font: PdfFontFamily;
  fontSizePt: number;
  colors: { primary: string; text: string; muted: string; tableHeader: string; rule: string };
  logo: { position: "left" | "right" | "center"; widthMm: number };
  header: { heightMm: number };
  footer: { mode: "AUTO" | "CUSTOM"; columns: number; minHeightMm: number };
  table: { zebra: boolean; rules: boolean; headerFill: boolean };
  marginsMm: { top: number; right: number; bottom: number; left: number };
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Farbe im Format #rrggbb angeben.");
const mm = (min: number, max: number) => z.number().min(min).max(max);

const baseSchema = z.strictObject({
  version: z.literal(1),
  blocks: z.array(z.enum(LAYOUT_BLOCK_KEYS)),
  columns: z.array(
    z.strictObject({
      key: z.enum(LAYOUT_COLUMN_KEYS),
      widthPct: z.number().int().min(4, "Eine Spalte braucht mindestens 4 %.").max(70, "Eine Spalte darf höchstens 70 % breit sein."),
    }),
  ),
  font: z.enum(PDF_FONT_FAMILIES),
  fontSizePt: z.number().min(8).max(12).multipleOf(0.5, "Schriftgröße in Schritten von 0,5 pt angeben."),
  colors: z.strictObject({ primary: hexColor, text: hexColor, muted: hexColor, tableHeader: hexColor, rule: hexColor }),
  logo: z.strictObject({ position: z.enum(["left", "right", "center"]), widthMm: z.number().int().min(10).max(80) }),
  header: z.strictObject({ heightMm: z.number().int().min(10).max(35) }),
  footer: z.strictObject({
    mode: z.enum(["AUTO", "CUSTOM"]),
    columns: z.number().int().min(1).max(4),
    minHeightMm: z.number().int().min(10).max(30),
  }),
  table: z.strictObject({ zebra: z.boolean(), rules: z.boolean(), headerFill: z.boolean() }),
  marginsMm: z.strictObject({
    top: mm(5, 20),
    right: mm(10, 25),
    bottom: mm(10, 30),
    left: mm(20, 25),
  }),
});

const REQUIRED_BLOCKS: LayoutBlockKey[] = ["lines", "totals", "payment"];
const REQUIRED_COLUMNS: LayoutColumnKey[] = ["description", "qty", "total"];

export const layoutDesignConfigSchema: z.ZodType<LayoutDesignConfig> = baseSchema.superRefine((cfg, ctx) => {
  const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

  // Bloecke
  const { blocks } = cfg;
  if (new Set(blocks).size !== blocks.length) add(["blocks"], "Jeder Block darf nur einmal vorkommen.");
  if (blocks[0] !== "sender" || blocks[1] !== "recipient" || blocks[2] !== "meta") {
    add(["blocks"], "Kopf nach DIN 5008: Absender, Empfänger und Belegdaten stehen fest oben.");
  } else {
    const idx = (k: LayoutBlockKey) => blocks.indexOf(k);
    let expected = 3;
    if (blocks[expected] === "subject") expected++;
    if (blocks[expected] === "intro") expected++;
    for (const k of ["subject", "intro"] as const) {
      const i = idx(k);
      if (i >= expected && blocks.indexOf(k) === blocks.lastIndexOf(k)) {
        add(["blocks"], `Der Block „${k === "subject" ? "Betreff" : "Einleitung"}“ steht direkt nach den Belegdaten.`);
      }
    }
    if (idx("subject") >= 0 && idx("intro") >= 0 && idx("subject") > idx("intro")) {
      add(["blocks"], "Der Betreff steht vor der Einleitung.");
    }
  }
  for (const k of REQUIRED_BLOCKS) {
    if (!blocks.includes(k)) add(["blocks"], `Pflichtblock fehlt: ${k}.`);
  }
  const iLines = blocks.indexOf("lines");
  const iTotals = blocks.indexOf("totals");
  const iGiro = blocks.indexOf("giro");
  if (iLines >= 0 && iTotals >= 0 && iLines > iTotals) add(["blocks"], "Die Positionen stehen vor den Summen.");
  if (iGiro >= 0 && iTotals >= 0 && iGiro < iTotals) add(["blocks"], "Der GiroCode steht nach den Summen.");

  // Spalten
  const keys = cfg.columns.map((c) => c.key);
  if (new Set(keys).size !== keys.length) add(["columns"], "Jede Spalte darf nur einmal vorkommen.");
  for (const k of REQUIRED_COLUMNS) {
    if (!keys.includes(k)) add(["columns"], `Pflichtspalte fehlt: ${k}.`);
  }
  const desc = cfg.columns.findIndex((c) => c.key === "description");
  if (desc >= 0 && cfg.columns[desc].widthPct < 20) {
    add(["columns", desc, "widthPct"], "Die Beschreibung braucht mindestens 20 % Breite.");
  }
  const sum = cfg.columns.reduce((s, c) => s + c.widthPct, 0);
  if (sum !== 100) add(["columns"], `Spaltenbreiten ergeben ${sum} % — benötigt sind 100 %.`);

  // DIN-5008-Fenster
  const headEnd = cfg.marginsMm.top + cfg.header.heightMm;
  if (headEnd > 45) {
    add(["header", "heightMm"], `Kopfzone endet bei ${headEnd} mm und ragt in das Anschriftfeld (ab 45 mm, DIN 5008 Form B).`);
  }
});

const CONTRAST_MIN = 4.5;

/** Farben mit weniger als 4,5:1 gegen Weiss (tableHeader: weisse Schrift auf der Fuellung). */
export function contrastWarnings(colors: LayoutDesignConfig["colors"]): { key: "primary" | "text" | "muted" | "tableHeader"; ratio: number }[] {
  const out: { key: "primary" | "text" | "muted" | "tableHeader"; ratio: number }[] = [];
  for (const key of ["primary", "text", "muted", "tableHeader"] as const) {
    const ratio = contrastRatio(colors[key], "#ffffff");
    if (ratio < CONTRAST_MIN) out.push({ key, ratio });
  }
  return out;
}
