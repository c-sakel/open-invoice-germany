/**
 * Fusszeile (Phase 11b, Task 2 — Zwischenstand): CUSTOM = die drei Freitextfelder aus
 * Phase 7 (footerLeft/-Center/-Right), sonst der bisherige Aussteller-/Bank-Fallback als
 * eine Spalte (Kompatibilitaet zum bisherigen `drawBrandedFooter`-Fallback). Die
 * automatische Vierspalten-Fusszeile aus den Stammdaten (AUTO) kommt in Task 3 — dieselbe
 * Funktionssignatur bleibt stabil, die Renderer rufen sie bereits jetzt so auf.
 *
 * Abweichung vom `footerMode`-Feld (bewusst, siehe Task-2/3-Report "Concerns"): die
 * Freitextspalten erscheinen, SOBALD footerLeft/-Center/-Right befuellt sind — nicht erst,
 * wenn `footerMode === "CUSTOM"` explizit gesetzt ist. `saveBrandingSettings` ersetzt beim
 * Speichern IMMER den gesamten Datensatz (kein Merge, siehe brandingSettingsInputSchema);
 * ein Aufruf, der nur `footerLeft` setzt, laesst `footerMode` also auf seinem Default
 * "AUTO" stehen. Vor Phase 11b (Task 1) gab es dieses Feld nicht — `drawBrandedFooter`
 * pruefte nur, ob footerLeft/-Center/-Right ueberhaupt Text trugen. Ein striktes Gate auf
 * `footerMode === "CUSTOM"` wuerde die bestehenden, als gruen vorausgesetzten
 * S3-Fix-Welle-Tests (`test/integration/pdf-theme.test.ts`) brechen, die genau dieses
 * Alt-Verhalten pruefen, ohne `footerMode` zu setzen.
 */
import type { BrandingSettingsInput } from "@/schemas/settings";
import type { FooterColumn } from "./layouts/types";

export interface FooterFacts {
  seller: { name: string; addressLine1: string; addressLine2?: string | null; postalCode: string; city: string; vatId?: string | null; taxNumber?: string | null; email?: string | null; phone?: string | null };
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  website?: string | null;
  ownerName?: string | null;
}

function compact(lines: (string | null | undefined | false)[]): string[] {
  return lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
}

export function buildFooterColumns(facts: FooterFacts, brand: BrandingSettingsInput): FooterColumn[] {
  const custom = compact([brand.footerLeft, brand.footerCenter, brand.footerRight]).map((t) => ({ lines: [t] }));
  if (custom.length > 0) return custom;
  const s = facts.seller;
  const sellerLine = compact([
    s.name,
    `${s.addressLine1}, ${s.postalCode} ${s.city}`,
    s.taxNumber ? `Steuernr.: ${s.taxNumber}` : null,
    s.vatId ? `USt-IdNr.: ${s.vatId}` : null,
  ]).join(" · ");
  const bankLine = compact([
    facts.bankName ? `Bank: ${facts.bankName}` : null,
    facts.iban ? `IBAN: ${facts.iban}` : null,
    facts.bic ? `BIC: ${facts.bic}` : null,
  ]).join(" · ");
  return [{ lines: compact([sellerLine, bankLine]) }];
}
