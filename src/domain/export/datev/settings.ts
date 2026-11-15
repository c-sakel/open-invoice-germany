/**
 * DATEV-Einstellungen je Organisation und Bestaetigung der Kontenzuordnung.
 * Die Bestaetigung wird ausschliesslich hier berechnet (Hash ueber alle Einstellungsfelder und alle
 * Zuordnungszeilen) und gilt nur, solange der Hash zur aktuellen Konfiguration passt.
 */
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import type { Prisma } from "@/generated/prisma/client";
import { logActivity } from "@/domain/activity/log";
import { datevConfirmNoteSchema, datevSettingsInputSchema, type DatevSettingsInput } from "@/schemas/datev";
import { datevConfigHash, type DatevConfigSettings } from "./confirm-hash";
import { DatevError } from "./errors";

type Db = Prisma.TransactionClient | typeof dbInternal;

export interface DatevSettingsView extends DatevConfigSettings {
  exists: boolean;
  confirmed: boolean;
  /** Es gab eine Bestaetigung, sie passt aber nicht mehr zur aktuellen Konfiguration. */
  confirmationStale: boolean;
  confirmedAt: Date | null;
  confirmedNote: string | null;
}

export const SETTINGS_SELECT = {
  consultantNumber: true,
  clientNumber: true,
  accountLength: true,
  chartOfAccounts: true,
  fiscalYearStartMonth: true,
  debtorMode: true,
  collectiveDebtorAccount: true,
  debtorRangeStart: true,
  bankAccount: true,
  cashAccount: true,
  exportPayments: true,
  exportDebtors: true,
  useGeneralReversal: true,
  lockBatch: true,
  dictationCode: true,
  confirmedHash: true,
  confirmedAt: true,
  confirmedNote: true,
} as const;

const MAPPING_SELECT = { kind: true, key: true, account: true, buKey: true } as const;

const DEFAULTS: DatevConfigSettings = {
  consultantNumber: null,
  clientNumber: null,
  accountLength: 4,
  chartOfAccounts: null,
  fiscalYearStartMonth: 1,
  debtorMode: "PERSONAL",
  collectiveDebtorAccount: null,
  debtorRangeStart: null,
  bankAccount: null,
  cashAccount: null,
  exportPayments: false,
  exportDebtors: true,
  useGeneralReversal: true,
  lockBatch: false,
  dictationCode: null,
};

/** Kontenbereiche je Sachkontenlaenge: Sachkonten 1..10^n-1, Personenkonten 10^n..7*10^n-1 (ab 7*10^n Kreditoren). */
export function accountRules(len: number): { sachMax: number; debtorMin: number; debtorMax: number } {
  const p = 10 ** len;
  return { sachMax: p - 1, debtorMin: p, debtorMax: 7 * p - 1 };
}

type SettingsRow = DatevConfigSettings & { confirmedHash: string | null; confirmedAt: Date | null; confirmedNote: string | null };

export function toConfig(row: DatevConfigSettings): DatevConfigSettings {
  return {
    consultantNumber: row.consultantNumber,
    clientNumber: row.clientNumber,
    accountLength: row.accountLength,
    chartOfAccounts: row.chartOfAccounts,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    debtorMode: row.debtorMode,
    collectiveDebtorAccount: row.collectiveDebtorAccount,
    debtorRangeStart: row.debtorRangeStart,
    bankAccount: row.bankAccount,
    cashAccount: row.cashAccount,
    exportPayments: row.exportPayments,
    exportDebtors: row.exportDebtors,
    useGeneralReversal: row.useGeneralReversal,
    lockBatch: row.lockBatch,
    dictationCode: row.dictationCode,
  };
}

async function buildView(db: Db, orgId: string, row: SettingsRow | null): Promise<DatevSettingsView> {
  if (!row) return { ...DEFAULTS, exists: false, confirmed: false, confirmationStale: false, confirmedAt: null, confirmedNote: null };
  const mapping = await db.datevAccountMapping.findMany({ where: { orgId }, select: MAPPING_SELECT });
  const current = datevConfigHash(toConfig(row), mapping);
  const confirmed = row.confirmedHash !== null && row.confirmedHash === current;
  return {
    ...toConfig(row),
    exists: true,
    confirmed,
    confirmationStale: row.confirmedHash !== null && !confirmed,
    confirmedAt: row.confirmedAt,
    confirmedNote: row.confirmedNote,
  };
}

export async function getDatevSettings(orgId: string, db: Db = dbInternal): Promise<DatevSettingsView> {
  const row = await db.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
  return buildView(db, orgId, row);
}

/** Prueft die Kontenbereiche der zusammengefuehrten Einstellungen (Sachkonten, Personenkonten). */
export function assertSettingsAccounts(s: DatevConfigSettings): void {
  const { sachMax, debtorMin, debtorMax } = accountRules(s.accountLength);
  const sach = (value: number | null, name: string) => {
    if (value !== null && (value < 1 || value > sachMax)) {
      throw new DatevError("ACCOUNT_OUT_OF_RANGE", `${name}: Sachkonto muss bei Kontenlaenge ${s.accountLength} zwischen 1 und ${sachMax} liegen.`);
    }
  };
  const person = (value: number | null, name: string) => {
    if (value !== null && (value < debtorMin || value > debtorMax)) {
      throw new DatevError("ACCOUNT_OUT_OF_RANGE", `${name}: Personenkonto muss bei Kontenlaenge ${s.accountLength} zwischen ${debtorMin} und ${debtorMax} liegen.`);
    }
  };
  sach(s.bankAccount, "Bankkonto");
  sach(s.cashAccount, "Kassenkonto");
  person(s.collectiveDebtorAccount, "Sammeldebitor");
  person(s.debtorRangeStart, "Debitorenbereich Start");
}

/**
 * Aenderung der Kontenlaenge: vergebene Debitorennummern und Zuordnungskonten muessen in die neuen Bereiche passen.
 * Hinweis fuer den Buchungsschreiber: Sachkonten der Vorlagen sind 4-stellig und muessen beim Schreiben auf die
 * eingestellte Kontenlaenge aufgefuellt werden (Padding mit Nullen rechts), nicht hier in der Zuordnung.
 */
async function assertAccountLengthChange(tx: Prisma.TransactionClient, orgId: string, length: number): Promise<void> {
  const { sachMax, debtorMin, debtorMax } = accountRules(length);
  const customers = await tx.customer.findMany({
    where: { orgId, datevAccount: { not: null } },
    select: { customerNumber: true, name: true, datevAccount: true },
    orderBy: { datevAccount: "asc" },
  });
  const badDebtors = customers.filter((c) => c.datevAccount !== null && (c.datevAccount < debtorMin || c.datevAccount > debtorMax));
  if (badDebtors.length > 0) {
    const list = badDebtors.slice(0, 10).map((c) => `${c.datevAccount} (${c.customerNumber ?? c.name})`).join(", ");
    throw new DatevError(
      "ACCOUNT_OUT_OF_RANGE",
      `Kontenlaenge ${length}: ${badDebtors.length} vergebene Debitorennummer(n) liegen ausserhalb ${debtorMin}..${debtorMax}: ${list}${badDebtors.length > 10 ? ", ..." : ""}.`,
    );
  }
  const mapping = await tx.datevAccountMapping.findMany({ where: { orgId }, select: { kind: true, key: true, account: true } });
  const badMapping = mapping.filter((m) => m.account < 1 || m.account > sachMax);
  if (badMapping.length > 0) {
    throw new DatevError(
      "ACCOUNT_OUT_OF_RANGE",
      `Kontenlaenge ${length}: Zuordnungskonten ausserhalb 1..${sachMax}: ${badMapping.slice(0, 10).map((m) => `${m.kind} ${m.key}`).join(", ")}.`,
    );
  }
}

function parseInput(raw: unknown): DatevSettingsInput {
  const r = datevSettingsInputSchema.safeParse(raw);
  if (!r.success) throw new DatevError("VALIDATION", r.error.issues.map((i) => `${i.path.join(".") || "Eingabe"}: ${i.message}`).join("; "));
  return r.data;
}

export async function saveDatevSettings(orgId: string, rawInput: unknown, actor: string): Promise<DatevSettingsView> {
  const input = parseInput(rawInput);
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const existing = await tx.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    const base: DatevConfigSettings = existing ? toConfig(existing) : DEFAULTS;
    const merged: DatevConfigSettings = { ...base };
    const changed: string[] = [];
    for (const key of Object.keys(input) as (keyof DatevSettingsInput)[]) {
      const value = input[key];
      if (value === undefined) continue;
      if (merged[key] !== value) {
        (merged as unknown as Record<string, unknown>)[key] = value;
        changed.push(key);
      }
    }
    assertSettingsAccounts(merged);
    if (existing && merged.accountLength !== existing.accountLength) await assertAccountLengthChange(tx, orgId, merged.accountLength);
    const data = toConfig(merged);
    // confirmed* wird hier nie geschrieben: die Bestaetigung erlischt durch den Hashvergleich.
    await tx.datevSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data, select: { id: true } });
    if (changed.length > 0 || !existing) {
      await logActivity(tx, { orgId, entityType: "DATEV", entityId: orgId, type: "DATEV_SETTINGS_SAVED", actor, data: { changed } });
    }
    const row = await tx.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    return buildView(tx, orgId, row);
  });
}

/**
 * Bestaetigt die aktuelle Kontenzuordnung (nur Oberflaeche, Administrator). Der Hash wird hier aus den
 * gespeicherten Einstellungen und ALLEN Zuordnungszeilen berechnet, nie vom Aufrufer uebernommen.
 * Zugriffsschutz: diese Funktion prueft keine Rolle. Aufrufer (Oberflaechen-Aktion) muss Administrator und
 * Origin-Pruefung erzwingen; sie wird weder ueber REST noch ueber MCP angeboten.
 */
export async function confirmDatevMapping(orgId: string, rawNote: unknown, actor: string): Promise<DatevSettingsView> {
  const n = datevConfirmNoteSchema.safeParse(rawNote);
  if (!n.success) throw new DatevError("VALIDATION", "Notiz: 3 bis 200 Zeichen ohne Steuerzeichen.");
  const note = n.data;
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const row = await tx.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    if (!row) throw new DatevError("SETTINGS_INCOMPLETE", "Einstellungen fehlen.");
    const s = toConfig(row);
    const missing: string[] = [];
    if (s.consultantNumber === null) missing.push("Beraternummer");
    if (s.clientNumber === null) missing.push("Mandantennummer");
    if (s.chartOfAccounts === null) missing.push("Kontenrahmen");
    if (s.exportPayments && s.bankAccount === null) missing.push("Bankkonto");
    if (s.debtorMode === "COLLECTIVE" ? s.collectiveDebtorAccount === null : s.debtorRangeStart === null) {
      missing.push(s.debtorMode === "COLLECTIVE" ? "Sammeldebitor" : "Debitorenbereich");
    }
    if (missing.length > 0) throw new DatevError("SETTINGS_INCOMPLETE", `Pflichtangaben fehlen: ${missing.join(", ")}.`);
    assertSettingsAccounts(s);
    const mapping = await tx.datevAccountMapping.findMany({ where: { orgId }, select: MAPPING_SELECT });
    const { sachMax } = accountRules(s.accountLength);
    const bad = mapping.find((m) => m.account < 1 || m.account > sachMax);
    if (bad) throw new DatevError("ACCOUNT_OUT_OF_RANGE", `Zuordnung ${bad.kind} ${bad.key}: Konto ${bad.account} liegt ausserhalb 1..${sachMax}.`);
    if (!mapping.some((m) => m.kind === "REVENUE")) {
      throw new DatevError("SETTINGS_INCOMPLETE", "Pflichtzuordnung fehlt: mindestens ein Erloeskonto muss zugeordnet sein.");
    }
    const hash = datevConfigHash(s, mapping);
    await tx.datevSettings.update({ where: { orgId }, data: { confirmedHash: hash, confirmedAt: new Date(), confirmedNote: note }, select: { id: true } });
    await logActivity(tx, { orgId, entityType: "DATEV", entityId: orgId, type: "DATEV_MAPPING_CONFIRMED", actor, data: { note, mappingRows: mapping.length } });
    const after = await tx.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    return buildView(tx, orgId, after);
  });
}
