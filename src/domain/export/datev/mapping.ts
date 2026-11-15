/** Kontenzuordnung (Erloese, Anzahlungen, Geldkonten) und Vorlagen. Aenderungen machen die Bestaetigung hinfaellig (Hashvergleich). */
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { datevMappingInputSchema, type DatevChart, type DatevMappingRow } from "@/schemas/datev";
import { DatevError } from "./errors";
import { accountRules, SETTINGS_SELECT, toConfig } from "./settings";
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
      if (r.account < 1 || r.account > sachMax) {
        throw new DatevError("ACCOUNT_OUT_OF_RANGE", `${r.kind} ${r.key}: Sachkonto muss zwischen 1 und ${sachMax} liegen.`);
      }
    }
    await tx.datevAccountMapping.deleteMany({ where: { orgId } });
    if (rows.length > 0) await tx.datevAccountMapping.createMany({ data: rows.map((r) => ({ orgId, kind: r.kind, key: r.key, account: r.account, buKey: r.buKey })) });
    await logActivity(tx, { orgId, entityType: "DATEV", entityId: orgId, type: "DATEV_MAPPING_SAVED", actor, data: { rows: rows.length } });
    const after = await tx.datevAccountMapping.findMany({ where: { orgId }, select: SELECT, orderBy: [{ kind: "asc" }, { key: "asc" }] });
    return after.map(narrow);
  });
}

/**
 * Uebernimmt die Vorlage des Kontenrahmens als Vorschlag: fehlende Zeilen werden ergaenzt, vorhandene
 * bleiben unveraendert. Kontenrahmen, Kontenlaenge 4, Debitorenbereichsbeginn sowie Bank/Kasse werden
 * nur gesetzt, wenn sie leer sind (Kontenlaenge und Kontenrahmen nur bei noch fehlendem Kontenrahmen). Bestaetigt nie.
 */
export async function applyDatevTemplate(orgId: string, chart: DatevChart, actor: string): Promise<{ added: number; kept: number }> {
  if (chart !== "SKR03" && chart !== "SKR04") throw new DatevError("VALIDATION", "Kontenrahmen: SKR03 oder SKR04.");
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const existingSettings = await tx.datevSettings.findUnique({ where: { orgId }, select: SETTINGS_SELECT });
    const cfg = existingSettings ? toConfig(existingSettings) : null;
    const { sachMax } = accountRules(cfg?.accountLength ?? TEMPLATE_ACCOUNT_LENGTH);
    const patch: Record<string, unknown> = {};
    if (!cfg) {
      patch.chartOfAccounts = chart;
      patch.accountLength = TEMPLATE_ACCOUNT_LENGTH;
      patch.debtorRangeStart = TEMPLATE_DEBTOR_RANGE_START;
      patch.bankAccount = TEMPLATE_BANK_ACCOUNT[chart];
      patch.cashAccount = TEMPLATE_CASH_ACCOUNT[chart];
    } else {
      if (cfg.chartOfAccounts === null) patch.chartOfAccounts = chart;
      if (cfg.debtorRangeStart === null && cfg.accountLength === TEMPLATE_ACCOUNT_LENGTH) patch.debtorRangeStart = TEMPLATE_DEBTOR_RANGE_START;
      if (cfg.bankAccount === null) patch.bankAccount = TEMPLATE_BANK_ACCOUNT[chart];
      if (cfg.cashAccount === null) patch.cashAccount = TEMPLATE_CASH_ACCOUNT[chart];
    }
    for (const v of [patch.bankAccount, patch.cashAccount]) {
      if (typeof v === "number" && v > sachMax) throw new DatevError("ACCOUNT_OUT_OF_RANGE", "Vorlage passt nicht zur Sachkontenlaenge.");
    }
    if (Object.keys(patch).length > 0) {
      await tx.datevSettings.upsert({ where: { orgId }, create: { orgId, ...patch }, update: patch, select: { id: true } });
    }
    const present = await tx.datevAccountMapping.findMany({ where: { orgId }, select: { kind: true, key: true } });
    const have = new Set(present.map((p) => `${p.kind}\u0000${p.key}`));
    const missing = datevTemplateRows(chart).filter((r) => !have.has(`${r.kind}\u0000${r.key}`) && r.account <= sachMax);
    if (missing.length > 0) {
      await tx.datevAccountMapping.createMany({ data: missing.map((r) => ({ orgId, kind: r.kind, key: r.key, account: r.account, buKey: null })) });
    }
    await logActivity(tx, {
      orgId,
      entityType: "DATEV",
      entityId: orgId,
      type: "DATEV_TEMPLATE_APPLIED",
      actor,
      data: { chart, added: missing.length, settingsFields: Object.keys(patch) },
    });
    return { added: missing.length, kept: present.length };
  });
}
