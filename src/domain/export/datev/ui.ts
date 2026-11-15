/**
 * Reine Darstellungslogik der DATEV-Seite: Zuordnungszeilen (Vorlage + benoetigte Schluessel + gespeicherte Zeilen),
 * lesbare Schluesselnamen und die serialisierbaren Vorschau-/Protokollbeschreibungen fuer die Oberflaeche.
 * Keine Datenbankzugriffe.
 */
import type { DatevChart, DatevMappingKind, DatevMappingRow } from "@/schemas/datev";
import { datevTemplateRows } from "./templates";
import type { UsedMappingKey } from "./used-keys";
import type { DatevPlan } from "./plan";
import type { DatevExportView } from "./run";

export interface MappingUiRow {
  kind: DatevMappingKind;
  key: string;
  /** Lesbare Beschreibung des Schluessels. */
  title: string;
  /** Kontobezeichnung der Vorlage (leer ohne Vorlage). */
  label: string;
  account: number | null;
  buKey: string | null;
  /** Anzahl festgeschriebener Belege/Zahlungen der Organisation mit diesem Schluessel. */
  count: number;
  /** Ohne Konto kann ein vorhandener Beleg bzw. eine Zahlung nicht exportiert werden. */
  required: boolean;
  missing: boolean;
  /** Vorlage kennt die Zeile, schlaegt aber kein Konto vor. */
  noSuggestion: boolean;
}

export const KIND_LABEL: Record<DatevMappingKind, string> = {
  REVENUE: "Erlöse",
  DOWNPAYMENT: "Anzahlungen",
  MONEY: "Geldkonten",
};

const SCHEME_LABEL: Record<string, string> = {
  REGULAR: "Regelbesteuerung",
  AUSFUHR: "Ausfuhr (Drittland)",
  IG_LIEFERUNG: "Innergemeinschaftliche Lieferung",
  IG_LEISTUNG: "Innergemeinschaftliche Leistung",
  REVERSE_CHARGE: "Reverse Charge (§ 13b)",
  NICHT_STEUERBAR: "Nicht steuerbar",
  KLEINUNTERNEHMER: "Kleinunternehmer",
  DIFFERENZ: "Differenzbesteuerung",
};

export function describeMappingKey(kind: DatevMappingKind, key: string): string {
  if (kind === "MONEY") {
    const [type, code = ""] = key.split(":");
    return type === "PROVIDER" ? `Geldtransit Zahlungsanbieter ${code}` : `Zahlungsart ${code}`;
  }
  const [scheme = "", category = "", rate = ""] = key.split("|");
  return `${SCHEME_LABEL[scheme] ?? scheme}, Kategorie ${category}, ${rate.replace(".", ",")} %`;
}

const KIND_ORDER: Record<DatevMappingKind, number> = { REVENUE: 0, DOWNPAYMENT: 1, MONEY: 2 };

export function buildMappingRows(input: {
  chart: DatevChart | null;
  mapping: readonly DatevMappingRow[];
  used: readonly UsedMappingKey[];
}): MappingUiRow[] {
  const rows = new Map<string, MappingUiRow>();
  const idOf = (kind: string, key: string) => `${kind}\u0000${key}`;
  const make = (kind: DatevMappingKind, key: string): MappingUiRow => ({
    kind, key, title: describeMappingKey(kind, key), label: "", account: null, buKey: null, count: 0, required: false, missing: false, noSuggestion: false,
  });
  const get = (kind: DatevMappingKind, key: string): MappingUiRow => {
    const id = idOf(kind, key);
    let r = rows.get(id);
    if (!r) {
      r = make(kind, key);
      rows.set(id, r);
    }
    return r;
  };
  if (input.chart) {
    for (const t of datevTemplateRows(input.chart)) {
      const r = get(t.kind, t.key);
      r.label = t.label;
      r.noSuggestion = t.account === null;
    }
  }
  for (const u of input.used) get(u.kind, u.key).count = u.count;
  for (const m of input.mapping) {
    const r = get(m.kind, m.key);
    r.account = m.account;
    r.buKey = m.buKey;
  }
  for (const r of rows.values()) {
    r.required = r.count > 0 && (r.kind !== "MONEY" || r.key.startsWith("PROVIDER:"));
    r.missing = r.required && r.account === null;
    // Eine Vorlagenzeile ohne Beleg und ohne Konto ist kein Hinweis auf eine Luecke.
    if (r.account !== null) r.noSuggestion = false;
  }
  return [...rows.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ── Vorschau und Protokoll ────────────────────────────────────────────────────

export interface PreviewDto {
  mode: "PERIOD" | "SUPPLEMENT";
  months: string[];
  lineCount: number;
  itemCount: number;
  manualCount: number;
  debtorCount: number;
  newDebtors: number;
  issues: { code: string; message: string; key?: string; documents?: string[] }[];
  manual: { reference: string; month: string; reason: string; amountCents: number; currency: string }[];
  repeats: { month: string; exportId: string; createdAt: string; identical: boolean | null }[];
}

export function toPreviewDto(plan: DatevPlan): PreviewDto {
  return {
    mode: plan.mode,
    months: plan.months,
    lineCount: plan.lineCount,
    itemCount: plan.items.filter((i) => !i.covered && i.status === "EXPORTED").length,
    manualCount: plan.manualCount,
    debtorCount: plan.debtorCount,
    newDebtors: plan.newDebtors,
    issues: plan.issues.map((i) => ({ code: i.code, message: i.message, ...(i.key ? { key: i.key } : {}), ...(i.documents ? { documents: i.documents } : {}) })),
    manual: plan.items
      .filter((i) => i.status === "MANUAL")
      .map((i) => ({ reference: i.reference, month: i.month, reason: i.reason ?? "", amountCents: i.amountCents, currency: i.currency ?? "EUR" })),
    repeats: plan.repeats.map((r) => ({ month: r.month, exportId: r.exportId, createdAt: r.createdAt.toISOString(), identical: r.identical })),
  };
}

export interface HistoryRowDto {
  id: string;
  mode: "PERIOD" | "SUPPLEMENT";
  fromMonth: string;
  toMonth: string;
  repeat: boolean;
  lineCount: number;
  manualCount: number;
  sha256: string;
  createdAt: string;
}

export function toHistoryRow(v: DatevExportView): HistoryRowDto {
  return {
    id: v.id, mode: v.mode, fromMonth: v.fromMonth, toMonth: v.toMonth, repeat: v.repeat, lineCount: v.lineCount,
    manualCount: v.manualCount, sha256: v.sha256, createdAt: v.createdAt.toISOString(),
  };
}
