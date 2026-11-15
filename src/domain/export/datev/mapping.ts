/** Kontenzuordnung (Erloese, Anzahlungen, Geldkonten) und Vorlagen. Aenderungen machen die Bestaetigung hinfaellig (Hashvergleich). */
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { datevMappingInputSchema, type DatevChart, type DatevMappingRow } from "@/schemas/datev";
import { DatevError } from "./errors";
import { accountRules, SACH_MIN, SETTINGS_SELECT, toConfig } from "./settings";
import {
  datevTemplateRows,
  TEMPLATE_ACCOUNT_LENGTH,
  TEMPLATE_BANK_ACCOUNT,
  TEMPLATE_CASH_ACCOUNT,
  TEMPLATE_DEBTOR_RANGE_START,
} from "./templates";

export type DatevMappingView = DatevMappingRow;

function narrow(r: { kind: string; key: string; account: number; buKey: string | null }): DatevMappingView {
  if (r.kind !== "REVENUE" && r.kind !== "DOWNPAYMENT" && r.kind !== "MONEY") throw new DatevError("VALIDATION", `Unbekannte Art ${r.kind}.`);
  return { kind: r.kind, key: r.key, account: r.account, buKey: r.buKey };
}

const SELECT = { kind: true, key: true, account: true, buKey: true } as const;

export async function listDatevMapping(orgId: string): Promise<DatevMappingView[]> {
  const rows = await dbInternal.datevAccountMapping.findMany({ where: { orgId }, select: SELECT, orderBy: [{ kind: "asc" }, { key: "asc" }] });
  return rows.map(narrow);
}

/** Ersetzt den gesamten Satz atomar. Konten werden gegen die Sachkontenlaenge der Einstellungen geprueft. */
export async function saveDatevMapping(orgId: string, rawRows: unknown, actor: string): Promise<DatevMappingView[]> {
  const parsed = datevMappingInputSchema.safeParse(rawRows);
  if (!parsed.success) throw new DatevError("VALIDATION", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const rows = parsed.data;
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.kind}\u0000${r.key}`;
    if (seen.has(id)) throw new DatevError("VALIDATION", `Zuordnung doppelt: ${r.kind} ${r.key}.`);
    seen.add(id);
  }
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const settings = await tx.datevSettings.findUnique({ where: { orgId }, select: { accountLength: true } });
    const { sachMax } = accountRules(settings?.accountLength ?? TEMPLATE_ACCOUNT_LENGTH);
    for (const r of rows) {
      if (r.account < SACH_MIN || r.account > sachMax) {
        throw new DatevError("ACCOUNT_OUT_OF_RANGE", `${r.kind} ${r.key}: Sachkonto muss zwischen ${SACH_MIN} und ${sachMax} liegen.`);
      }
    }
    await tx.datevAccountMapping.deleteMany({ where: { orgId } });
    if (rows.length > 0) await tx.datevAccountMapping.createMany({ data: rows.map((r) => ({ orgId, kind: r.kind, key: r.key, account: r.account, buKey: r.buKey })) });
    await logActivity(tx, { orgId, entityType: "DATEV", entityId: orgId, type: "DATEV_MAPPING_SAVED", actor, data: { rows: rows.length } });
    const after = await tx.datevAccountMapping.findMany({ where: { orgId }, select: SELECT, orderBy: [{ kind: "asc" }, { key: "asc" }] });
    return after.map(narrow);
  });
}

export interface DatevTemplateResult {
  added: number;
  kept: number;
  /** Zeilen/Felder, die durch den Kontenrahmenwechsel ersetzt wurden (unveraenderte Vorschlagswerte). */
  replaced: number;
  /** Manuell geaenderte Zeilen/Felder, die beim Wechsel unveraendert blieben (nur ohne `overwriteEdited`). */
  keptEdited: string[];
  /** Vorlagenzeilen ohne Vorschlag: das Konto nennt der Steuerberater. */
  withoutSuggestion: string[];
}

/**
 * Uebernimmt die Vorlage des Kontenrahmens als Vorschlag: fehlende Zeilen werden ergaenzt, vorhandene
 * bleiben unveraendert. Kontenrahmen, Kontenlaenge 4, Debitorenbereichsbeginn sowie Bank/Kasse werden
 * nur gesetzt, wenn sie leer sind. Bestaetigt nie.
 * Wechsel des Kontenrahmens: die Vorschlagswerte des bisherigen Rahmens (Zeilen, Bank, Kasse, die noch genau
 * der alten Vorlage entsprechen) werden vollstaendig durch die des neuen ersetzt, damit sich nie zwei Rahmen
 * mischen. Manuell geaenderte Werte bleiben unveraendert und werden gemeldet, ausser `overwriteEdited` ist
 * ausdruecklich gesetzt.
 */
export async function applyDatevTemplate(
  orgId: string,
  chart: DatevChart,
  actor: string,
  options: { overwriteEdited?: boolean } = {},
): Promise<DatevTemplateResult> {
  if (chart !== "SKR03" && chart !== "SKR04") throw new DatevError("VALIDATION", "Kontenrahmen: SKR03 oder SKR04.");
  const overwrite = options.overwriteEdited === true;
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const existingSettings = await tx.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    const cfg = existingSettings ? toConfig(existingSettings) : null;
    const { sachMax } = accountRules(cfg?.accountLength ?? TEMPLATE_ACCOUNT_LENGTH);
    const previous: DatevChart | null = cfg?.chartOfAccounts === "SKR03" || cfg?.chartOfAccounts === "SKR04" ? cfg.chartOfAccounts : null;
    const switching = previous !== null && previous !== chart;
    const patch: Record<string, unknown> = {};
    const keptEdited: string[] = [];
    let replaced = 0;
    if (!cfg) {
      patch.chartOfAccounts = chart;
      patch.accountLength = TEMPLATE_ACCOUNT_LENGTH;
      patch.debtorRangeStart = TEMPLATE_DEBTOR_RANGE_START;
      patch.bankAccount = TEMPLATE_BANK_ACCOUNT[chart];
      patch.cashAccount = TEMPLATE_CASH_ACCOUNT[chart];
    } else {
      if (previous === null) patch.chartOfAccounts = chart;
      if (cfg.debtorRangeStart === null && cfg.accountLength === TEMPLATE_ACCOUNT_LENGTH) patch.debtorRangeStart = TEMPLATE_DEBTOR_RANGE_START;
      const fields = [
        ["bankAccount", "Bankkonto", TEMPLATE_BANK_ACCOUNT, cfg.bankAccount],
        ["cashAccount", "Kassenkonto", TEMPLATE_CASH_ACCOUNT, cfg.cashAccount],
      ] as const;
      for (const [field, label, table, current] of fields) {
        if (current === null) patch[field] = table[chart];
        else if (previous !== null && switching) {
          if (current === table[previous]) {
            patch[field] = table[chart];
            replaced += 1;
          } else if (overwrite) {
            patch[field] = table[chart];
            replaced += 1;
          } else keptEdited.push(label);
        }
      }
      if (switching) patch.chartOfAccounts = chart;
    }
    for (const v of [patch.bankAccount, patch.cashAccount]) {
      if (typeof v === "number" && v > sachMax) throw new DatevError("ACCOUNT_OUT_OF_RANGE", "Vorlage passt nicht zur Sachkontenlaenge.");
    }
    if (Object.keys(patch).length > 0) {
      await tx.datevSettings.upsert({ where: { orgId }, create: { orgId, ...patch }, update: patch, select: { id: true } });
    }

    const rows = await tx.datevAccountMapping.findMany({ where: { orgId }, select: { id: true, kind: true, key: true, account: true, buKey: true } });
    const target = new Map(datevTemplateRows(chart).map((r) => [`${r.kind}\u0000${r.key}`, r]));
    const old = previous !== null && switching ? new Map(datevTemplateRows(previous).map((r) => [`${r.kind}\u0000${r.key}`, r])) : null;
    if (old) {
      for (const row of rows) {
        const id = `${row.kind}\u0000${row.key}`;
        const was = old.get(id);
        const now = target.get(id);
        if (!was || !now) continue; // eigene Zeile ohne Vorlage: bleibt
        const untouched = row.buKey === null && was.account !== null && row.account === was.account;
        if (!untouched && !overwrite) {
          keptEdited.push(`${row.kind} ${row.key}`);
          continue;
        }
        if (now.account === null) {
          await tx.datevAccountMapping.delete({ where: { id: row.id }, select: { id: true } });
        } else if (now.account <= sachMax) {
          await tx.datevAccountMapping.update({ where: { id: row.id }, data: { account: now.account, buKey: null }, select: { id: true } });
        } else continue;
        replaced += 1;
      }
    }
    const present = await tx.datevAccountMapping.findMany({ where: { orgId }, select: { kind: true, key: true } });
    const have = new Set(present.map((p) => `${p.kind}\u0000${p.key}`));
    const templateRows = datevTemplateRows(chart);
    const withoutSuggestion = templateRows.filter((r) => r.account === null && !have.has(`${r.kind}\u0000${r.key}`)).map((r) => `${r.kind} ${r.key}`);
    const missing: { kind: DatevMappingView["kind"]; key: string; account: number }[] = [];
    for (const r of templateRows) {
      if (r.account !== null && r.account <= sachMax && !have.has(`${r.kind}\u0000${r.key}`)) missing.push({ kind: r.kind, key: r.key, account: r.account });
    }
    if (missing.length > 0) {
      await tx.datevAccountMapping.createMany({ data: missing.map((r) => ({ orgId, kind: r.kind, key: r.key, account: r.account, buKey: null })) });
    }
    await logActivity(tx, {
      orgId,
      entityType: "DATEV",
      entityId: orgId,
      type: "DATEV_TEMPLATE_APPLIED",
      actor,
      data: { chart, added: missing.length, replaced, keptEdited: keptEdited.length, settingsFields: Object.keys(patch) },
    });
    return { added: missing.length, kept: present.length, replaced, keptEdited, withoutSuggestion };
  });
}
