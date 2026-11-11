/**
 * Reine Bearbeitungslogik des Layout-Designers (Phase 16g): Bloecke und Spalten verschieben und
 * ein-/ausschalten. Die Ergebnisse sind Vorschlaege; die Regeln des Konfigurationsschemas
 * (`layoutDesignConfigSchema`) bleiben die einzige Pruefinstanz.
 */
import { DEFAULT_COLUMNS, LAYOUT_COLUMN_KEYS, type LayoutBlockKey, type LayoutColumnKey } from "@/schemas/layout-design";

export type LayoutColumn = { key: LayoutColumnKey; widthPct: number };

/** Die ersten drei Bloecke (Absender, Empfaenger, Belegdaten) stehen nach DIN 5008 fest oben. */
export const FIXED_HEAD_COUNT = 3;

/** Bloecke, die abgeschaltet werden duerfen; alle anderen sind Pflichtangaben oder Kopf. */
export const OPTIONAL_BLOCKS: readonly LayoutBlockKey[] = ["subject", "intro", "giro", "outro"];

/** Spalten, die nicht abgeschaltet werden duerfen. */
export const REQUIRED_COLUMNS: readonly LayoutColumnKey[] = ["description", "qty", "total"];

const MIN_DESCRIPTION_PCT = 20;
const MIN_COLUMN_PCT = 4;
const FALLBACK_COLUMN_PCT = 8;

/** Verschiebt `key` an den Zielindex der Ergebnisliste; Kopfbloecke bleiben stehen, Ziel < 3 -> 3. */
export function moveBlock(blocks: readonly LayoutBlockKey[], key: LayoutBlockKey, to: number): LayoutBlockKey[] {
  const from = blocks.indexOf(key);
  if (from < FIXED_HEAD_COUNT) return [...blocks];
  const target = Math.max(FIXED_HEAD_COUNT, Math.min(blocks.length - 1, to));
  if (target === from) return [...blocks];
  const next = [...blocks];
  next.splice(from, 1);
  next.splice(target, 0, key);
  return next;
}

/** Schaltet einen optionalen Block aus bzw. fuegt ihn an der vom Schema erlaubten Stelle ein. */
export function toggleBlock(blocks: readonly LayoutBlockKey[], key: LayoutBlockKey): LayoutBlockKey[] {
  if (!OPTIONAL_BLOCKS.includes(key)) return [...blocks];
  const at = blocks.indexOf(key);
  if (at >= 0) return blocks.filter((b) => b !== key);
  const next = [...blocks];
  const insert = (index: number) => next.splice(index, 0, key);
  switch (key) {
    case "subject":
      insert(FIXED_HEAD_COUNT);
      break;
    case "intro":
      insert(next.indexOf("subject") >= 0 ? next.indexOf("subject") + 1 : FIXED_HEAD_COUNT);
      break;
    case "giro": {
      const totals = next.indexOf("totals");
      insert(totals >= 0 ? totals + 1 : next.length);
      break;
    }
    case "outro": {
      const anchor = Math.max(next.indexOf("totals"), next.indexOf("giro"));
      insert(anchor >= 0 ? anchor + 1 : next.length);
      break;
    }
    default:
      break;
  }
  return next;
}

/** Tauscht die Spalte mit ihrem Nachbarn; am Rand unveraendert. */
export function moveColumn(columns: readonly LayoutColumn[], key: LayoutColumnKey, dir: "up" | "down"): LayoutColumn[] {
  const from = columns.findIndex((c) => c.key === key);
  const to = dir === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= columns.length) return columns.map((c) => ({ ...c }));
  const next = columns.map((c) => ({ ...c }));
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/**
 * Schaltet eine Spalte aus (ihr Anteil geht an `description`) bzw. ein (der Anteil kommt von
 * `description`, hoechstens soweit diese mindestens 20 % behaelt). Pflichtspalten bleiben.
 */
export function toggleColumn(columns: readonly LayoutColumn[], key: LayoutColumnKey): LayoutColumn[] {
  if (REQUIRED_COLUMNS.includes(key)) return columns.map((c) => ({ ...c }));
  const current = columns.find((c) => c.key === key);
  const descIndex = columns.findIndex((c) => c.key === "description");
  if (descIndex < 0) return columns.map((c) => ({ ...c }));
  if (current) {
    return columns
      .filter((c) => c.key !== key)
      .map((c) => (c.key === "description" ? { ...c, widthPct: c.widthPct + current.widthPct } : { ...c }));
  }
  const desc = columns[descIndex]!;
  const wanted = DEFAULT_COLUMNS.find((c) => c.key === key)?.widthPct ?? FALLBACK_COLUMN_PCT;
  const width = Math.min(wanted, desc.widthPct - MIN_DESCRIPTION_PCT);
  if (width < MIN_COLUMN_PCT) return columns.map((c) => ({ ...c }));
  const rank = (k: LayoutColumnKey) => LAYOUT_COLUMN_KEYS.indexOf(k);
  const next = columns.map((c) => (c.key === "description" ? { ...c, widthPct: c.widthPct - width } : { ...c }));
  const before = next.findIndex((c) => rank(c.key) > rank(key));
  next.splice(before < 0 ? next.length : before, 0, { key, widthPct: width });
  return next;
}

export function columnSum(columns: readonly LayoutColumn[]): number {
  return columns.reduce((sum, c) => sum + c.widthPct, 0);
}

/** Schemafehler je Feldpfad (`columns`, `header.heightMm`, ...), fuer die Anzeige am Feld. */
export type FieldErrors = Record<string, string[]>;

export function collectFieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
