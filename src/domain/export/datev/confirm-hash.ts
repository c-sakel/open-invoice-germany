/**
 * Pruefsumme der exportrelevanten Konfiguration. Die Bestaetigung der Kontenzuordnung gilt nur, solange
 * die gespeicherte Summe der aktuellen entspricht; jede Aenderung an Einstellungen oder Zuordnung
 * (auch direkt in der Datenbank) macht sie hinfaellig. Der Wert entsteht nur serverseitig.
 */
import { createHash } from "node:crypto";

/** Alle Einstellungsfelder, die in die Summe eingehen (ohne id, orgId, Bestaetigungsfelder, Zeitstempel). */
export interface DatevConfigSettings {
  consultantNumber: number | null;
  clientNumber: number | null;
  accountLength: number;
  chartOfAccounts: string | null;
  fiscalYearStartMonth: number;
  debtorMode: string;
  collectiveDebtorAccount: number | null;
  debtorRangeStart: number | null;
  bankAccount: number | null;
  cashAccount: number | null;
  exportPayments: boolean;
  exportDebtors: boolean;
  useGeneralReversal: boolean;
  lockBatch: boolean;
  dictationCode: string | null;
}

export interface DatevConfigMappingRow {
  kind: string;
  key: string;
  account: number;
  buKey: string | null;
}

/** Feste Feldreihenfolge: kanonische Serialisierung unabhaengig von Objekt- und Zeilenreihenfolge. */
export function canonicalDatevConfig(settings: DatevConfigSettings, mapping: readonly DatevConfigMappingRow[]): string {
  const s = settings;
  const settingsPart = [
    s.consultantNumber,
    s.clientNumber,
    s.accountLength,
    s.chartOfAccounts,
    s.fiscalYearStartMonth,
    s.debtorMode,
    s.collectiveDebtorAccount,
    s.debtorRangeStart,
    s.bankAccount,
    s.cashAccount,
    s.exportPayments,
    s.exportDebtors,
    s.useGeneralReversal,
    s.lockBatch,
    s.dictationCode,
  ];
  const rows = [...mapping]
    .map((m) => [m.kind, m.key, m.account, m.buKey] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return JSON.stringify({ v: 1, settings: settingsPart, mapping: rows });
}

export function datevConfigHash(settings: DatevConfigSettings, mapping: readonly DatevConfigMappingRow[]): string {
  return createHash("sha256").update(canonicalDatevConfig(settings, mapping), "utf8").digest("hex");
}
