/**
 * Statische Konstanten für den gemeinsamen Beleg-Editor (Phase 11c). Steuerkategorie
 * und Pflichthinweistexte werden bewusst NICHT hier neu definiert, sondern von der
 * bestehenden, massgeblichen Quelle übernommen (Lastenheft 1.4/61.5 — nichts doppelt
 * bauen): `defaultCategoryForScheme` (`@/lib/tax`) bzw. `SCHEME_NOTICE`
 * (`@/domain/invoice/mandatory`, dort bereits von `validateMandatoryFields` geprüft).
 */
import { TaxScheme as TaxSchemeSchema, type TaxScheme, type TaxCategory } from "@/schemas";
import { defaultCategoryForScheme } from "@/lib/tax";
import { SCHEME_NOTICE as MANDATORY_SCHEME_NOTICE } from "@/domain/invoice/mandatory";

export type EditorMode = "INVOICE" | "DOCUMENT" | "DELIVERY_NOTE";

export const LINE_TYPE_LABEL: Record<"ITEM" | "HEADING" | "TEXT" | "SUBTOTAL", string> = {
  ITEM: "Position",
  HEADING: "Überschrift",
  TEXT: "Textblock",
  SUBTOTAL: "Zwischensumme",
};

export const TAX_RATE_OPTIONS: readonly { value: 19 | 7 | 0; label: string }[] = [
  { value: 19, label: "19%" },
  { value: 7, label: "7%" },
  { value: 0, label: "0%" },
];

// UN/ECE Rec 20 Einheiten-Codes (Teilmenge, siehe Hinweistext in
// src/components/forms/ProductForm.tsx) — C62 (Stück) zuerst als Standardwert.
export const UNIT_OPTIONS: readonly { code: string; label: string }[] = [
  { code: "C62", label: "Stk" },
  { code: "HUR", label: "Stunde" },
  { code: "DAY", label: "Tag" },
  { code: "KGM", label: "kg" },
  { code: "MTR", label: "m" },
];

// Vollständiges Record (alle TaxScheme-Werte) für synchrone Lookups je Zeile/Beleg,
// ohne Funktionsaufruf in Schleifen — Werte identisch mit defaultCategoryForScheme.
export const SCHEME_CATEGORY: Record<TaxScheme, TaxCategory> = Object.fromEntries(
  TaxSchemeSchema.options.map((scheme) => [scheme, defaultCategoryForScheme(scheme)]),
) as Record<TaxScheme, TaxCategory>;

// Pflichthinweistexte (§ 14a UStG) — identisch mit src/domain/invoice/mandatory.ts
// (dort die massgebliche Quelle, siehe validateMandatoryFields).
export const SCHEME_NOTICE: Partial<Record<TaxScheme, string>> = MANDATORY_SCHEME_NOTICE as Partial<Record<TaxScheme, string>>;
