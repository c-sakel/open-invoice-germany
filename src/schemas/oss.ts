/**
 * OSS-Schwelle (Phase 16e, § 3c Abs. 4 UStG): Zaehlmodus, Produkt-/Positionskategorie und
 * Hinweistext. Gemeinsame Quelle fuer Einstellungen, Produkt, Beleg-Position, REST und MCP.
 */
import { z } from "zod";

export const OssCountModeSchema = z.enum(["ALL_EU_B2C", "BY_PRODUCT"]);
export type OssCountMode = z.infer<typeof OssCountModeSchema>;

export const OssCategorySchema = z.enum(["NONE", "GOODS_DISTANCE", "ELECTRONIC_SERVICE"]);
export type OssCategory = z.infer<typeof OssCategorySchema>;

/** Kategorien, die im Zaehlmodus BY_PRODUCT in die Schwelle einfliessen. */
export const OSS_COUNTED_CATEGORIES: ReadonlySet<OssCategory> = new Set<OssCategory>(["GOODS_DISTANCE", "ELECTRONIC_SERVICE"]);

export const OSS_CATEGORY_LABELS: Record<OssCategory, string> = {
  NONE: "Keine (nicht OSS-relevant)",
  GOODS_DISTANCE: "Fernverkauf von Waren (§ 3c UStG)",
  ELECTRONIC_SERVICE: "Telekommunikation, Rundfunk, elektronische Leistung (§ 3a Abs. 5 UStG)",
};

export const OSS_NOTICE = "Hinweis zur Orientierung, keine steuerliche Beratung; maßgeblich sind Ihre Aufzeichnungen.";

export const ossQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2999).optional() });
