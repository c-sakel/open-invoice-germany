/**
 * Vorschlaege fuer die Kontenzuordnung nach SKR03 und SKR04. Nur Vorschlag: fehlende Zeilen werden
 * eingefuegt, vorhandene nie ueberschrieben, bestaetigt wird nie automatisch. Der Steuerberater
 * stimmt die Konten ab. Quelle der Kontonummern und -bezeichnungen: Vorgabe der Kontenrahmen SKR03/SKR04
 * (Erloes-, Anzahlungs-, Geldtransit-, Kassen- und Bankkonten) wie im Projekt festgelegt; die Formatquellen
 * unter datev-format enthalten keine Kontenrahmen. Ohne Vorschlag bleibt die Differenzbesteuerung.
 * Die Automatikkonten tragen bewusst keinen BU-Schluessel (Steuer ergibt sich aus dem Konto).
 * Konten, die nicht sicher belegt sind, haben bewusst KEINEN Vorschlag (account null): die Nummer muss vom
 * Steuerberater kommen und wird nicht geraten.
 */
import type { DatevChart, DatevMappingKind } from "@/schemas/datev";

export interface DatevTemplateRow {
  kind: DatevMappingKind;
  key: string;
  /** null = kein Vorschlag, das Konto nennt der Steuerberater. */
  account: number | null;
  buKey: null;
  /** Kontobezeichnung laut Kontenrahmen. */
  label: string;
}

type Pair = { skr03: number | null; skr04: number | null; kind: DatevMappingKind; key: string; label: string };

const PAIRS: readonly Pair[] = [
  { kind: "REVENUE", key: "REGULAR|S|19", skr03: 8400, skr04: 4400, label: "Erloese 19 % USt (AM)" },
  { kind: "REVENUE", key: "REGULAR|S|7", skr03: 8300, skr04: 4300, label: "Erloese 7 % USt (AM)" },
  { kind: "REVENUE", key: "REGULAR|Z|0", skr03: null, skr04: null, label: "Erloese 0 % USt (AM)" },
  { kind: "REVENUE", key: "AUSFUHR|G|0", skr03: 8120, skr04: 4120, label: "Steuerfreie Umsaetze nach § 4 Nr. 1a UStG (AM)" },
  { kind: "REVENUE", key: "IG_LIEFERUNG|K|0", skr03: 8125, skr04: 4125, label: "Steuerfreie innergemeinschaftliche Lieferungen nach § 4 Nr. 1b UStG (AM)" },
  { kind: "REVENUE", key: "IG_LEISTUNG|AE|0", skr03: 8336, skr04: 4336, label: "Erloese aus im anderen EU-Land steuerpflichtigen sonstigen Leistungen, Empfaenger schuldet USt (AM)" },
  { kind: "REVENUE", key: "REVERSE_CHARGE|AE|0", skr03: 8337, skr04: 4337, label: "Erloese aus Leistungen nach § 13b UStG (AM)" },
  { kind: "REVENUE", key: "NICHT_STEUERBAR|O|0", skr03: 8338, skr04: 4338, label: "Erloese aus im Drittland steuerbaren Leistungen (AM)" },
  { kind: "REVENUE", key: "KLEINUNTERNEHMER|E|0", skr03: 8195, skr04: 4185, label: "Steuerfreie Erloese Kleinunternehmer nach § 19 Abs. 1 UStG (AM)" },
  { kind: "DOWNPAYMENT", key: "REGULAR|S|19", skr03: 1718, skr04: 3272, label: "Erhaltene, versteuerte Anzahlungen 19 % USt (AM)" },
  { kind: "DOWNPAYMENT", key: "REGULAR|S|7", skr03: 1711, skr04: 3260, label: "Erhaltene, versteuerte Anzahlungen 7 % USt (AM)" },
  { kind: "MONEY", key: "PROVIDER:MOLLIE", skr03: 1360, skr04: 1460, label: "Geldtransit" },
  { kind: "MONEY", key: "PROVIDER:STRIPE", skr03: 1360, skr04: 1460, label: "Geldtransit" },
];

/** Bank (Einstellung `bankAccount`) und Kasse laut Kontenrahmen. */
export const TEMPLATE_BANK_ACCOUNT: Record<DatevChart, number> = { SKR03: 1200, SKR04: 1800 };
export const TEMPLATE_CASH_ACCOUNT: Record<DatevChart, number> = { SKR03: 1000, SKR04: 1600 };

/** Personenkontenbereich laut Vorgabe (beide Kontenrahmen, Laenge 4): 10000-69999. */
export const TEMPLATE_DEBTOR_RANGE_START = 10000;
export const TEMPLATE_ACCOUNT_LENGTH = 4;

export function datevTemplateRows(chart: DatevChart): DatevTemplateRow[] {
  return PAIRS.map((p) => ({ kind: p.kind, key: p.key, account: chart === "SKR03" ? p.skr03 : p.skr04, buKey: null, label: p.label }));
}
