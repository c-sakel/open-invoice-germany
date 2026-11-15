import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { iso } from "./common";
import type { DatevExportItemView, DatevExportView, DatevPlan, DatevStatus } from "@/domain/export/datev/run";
import type { DatevSettingsView } from "@/domain/export/datev/settings";
import type { DatevMappingView } from "@/domain/export/datev/mapping";

export function serializeDatevSettings(v: DatevSettingsView) {
  return {
    objectName: "DatevSettings" as const,
    exists: v.exists,
    consultantNumber: v.consultantNumber,
    clientNumber: v.clientNumber,
    accountLength: v.accountLength,
    chartOfAccounts: v.chartOfAccounts,
    fiscalYearStartMonth: v.fiscalYearStartMonth,
    debtorMode: v.debtorMode,
    collectiveDebtorAccount: v.collectiveDebtorAccount,
    debtorRangeStart: v.debtorRangeStart,
    bankAccount: v.bankAccount,
    cashAccount: v.cashAccount,
    exportPayments: v.exportPayments,
    exportPaymentsSince: iso(v.exportPaymentsSince),
    exportDebtors: v.exportDebtors,
    useGeneralReversal: v.useGeneralReversal,
    lockBatch: v.lockBatch,
    dictationCode: v.dictationCode,
    confirmed: v.confirmed,
    confirmationStale: v.confirmationStale,
    confirmedAt: iso(v.confirmedAt),
    confirmedNote: v.confirmedNote,
  };
}

export const datevSettingsSchema = z.object({
  objectName: z.literal("DatevSettings"),
  exists: z.boolean(),
  consultantNumber: z.number().int().nullable(),
  clientNumber: z.number().int().nullable(),
  accountLength: z.number().int(),
  chartOfAccounts: z.string().nullable(),
  fiscalYearStartMonth: z.number().int(),
  debtorMode: z.string(),
  collectiveDebtorAccount: z.number().int().nullable(),
  debtorRangeStart: z.number().int().nullable(),
  bankAccount: z.number().int().nullable(),
  cashAccount: z.number().int().nullable(),
  exportPayments: z.boolean(),
  exportPaymentsSince: z.string().nullable(),
  exportDebtors: z.boolean(),
  useGeneralReversal: z.boolean(),
  lockBatch: z.boolean(),
  dictationCode: z.string().nullable(),
  confirmed: z.boolean().describe("Die Kontenzuordnung ist bestaetigt und die Konfiguration seitdem unveraendert. Bestaetigt wird nur in der Oberflaeche."),
  confirmationStale: z.boolean().describe("Es gab eine Bestaetigung, die Konfiguration wurde danach geaendert."),
  confirmedAt: z.string().nullable(),
  confirmedNote: z.string().nullable(),
});

export function serializeDatevMappingRow(r: DatevMappingView) {
  return { objectName: "DatevAccountMapping" as const, kind: r.kind, key: r.key, account: r.account, buKey: r.buKey };
}

export const datevMappingRowOutSchema = z.object({
  objectName: z.literal("DatevAccountMapping"),
  kind: z.enum(["REVENUE", "DOWNPAYMENT", "MONEY"]),
  key: z.string(),
  account: z.number().int(),
  buKey: z.string().nullable(),
});

export const datevTemplateResultSchema = z.object({
  added: z.number().int(),
  kept: z.number().int(),
  replaced: z.number().int(),
  keptEdited: z.array(z.string()),
  withoutSuggestion: z.array(z.string()),
});

const fileSchema = z.object({
  name: z.string(),
  kind: z.enum(["BOOKINGS", "DEBTORS", "PROTOCOL"]),
  month: z.string().nullable(),
  lineCount: z.number().int(),
  sha256: z.string(),
  contentSha256: z.string(),
});
const manualSchema = z.object({ key: z.string(), month: z.string(), reason: z.string(), amountCents: z.number().int(), currency: z.string(), reference: z.string() });
const repeatSchema = z.object({
  month: z.string(),
  exportId: z.string(),
  createdAt: z.string().nullable(),
  contentSha256: z.string(),
  identical: z.boolean().nullable().describe("Neuer Inhalt gleich dem frueheren Stapel des Monats."),
});
const issueSchema = z.object({ code: z.string(), message: z.string(), key: z.string().optional(), documents: z.array(z.string()).optional() });

export function serializeDatevExport(v: DatevExportView) {
  return {
    objectName: "DatevExport" as const,
    id: v.id,
    mode: v.mode,
    fromMonth: v.fromMonth,
    toMonth: v.toMonth,
    repeat: v.repeat,
    lineCount: v.lineCount,
    itemCount: v.itemCount,
    manualCount: v.manualCount,
    debtorCount: v.debtorCount,
    sha256: v.sha256,
    files: v.files,
    manual: v.manual.map((m) => ({ ...m, currency: m.currency ?? "EUR" })),
    repeats: v.repeats.map((r) => ({ month: r.month, exportId: r.exportId, createdAt: iso(r.createdAt), contentSha256: r.contentSha256, identical: r.identical })),
    createdBy: v.createdBy,
    createdAt: iso(v.createdAt),
  };
}

export const datevExportSchema = z.object({
  objectName: z.literal("DatevExport"),
  id: z.string(),
  mode: z.enum(["PERIOD", "SUPPLEMENT"]),
  fromMonth: z.string(),
  toMonth: z.string(),
  repeat: z.boolean(),
  lineCount: z.number().int(),
  itemCount: z.number().int(),
  manualCount: z.number().int(),
  debtorCount: z.number().int(),
  sha256: z.string().describe("SHA-256 der ZIP-Datei; stimmt mit der Archivdatei ueberein."),
  files: z.array(fileSchema),
  manual: z.array(manualSchema).describe("Posten, die von Hand gebucht werden muessen."),
  repeats: z.array(repeatSchema),
  createdBy: z.string(),
  createdAt: z.string().nullable(),
});

export function serializeDatevItem(i: DatevExportItemView) {
  return { objectName: "DatevExportItem" as const, ...i };
}

export const datevItemSchema = z.object({
  objectName: z.literal("DatevExportItem"),
  itemKey: z.string(),
  invoiceId: z.string().nullable(),
  paymentId: z.string().nullable(),
  customerId: z.string().nullable(),
  month: z.string(),
  status: z.string(),
  lineCount: z.number().int(),
  amountCents: z.number().int(),
  reason: z.string().nullable(),
  warning: z.string().nullable(),
});

export const datevExportDetailSchema = datevExportSchema.extend({
  items: z.array(datevItemSchema),
  itemTotal: z.number().int(),
  itemLimit: z.number().int(),
  itemOffset: z.number().int(),
});

/** Vorschau ohne Buchungszeilen: Zaehler, Dateien, Hinweise, Wiederholungen und die Posten fuer Handbuchung. */
export function serializeDatevPlan(p: DatevPlan) {
  return {
    objectName: "DatevPlan" as const,
    mode: p.mode,
    months: p.months,
    files: p.files,
    issues: p.issues,
    repeats: p.repeats.map((r) => ({ month: r.month, exportId: r.exportId, createdAt: iso(r.createdAt), contentSha256: r.contentSha256, identical: r.identical })),
    newDebtors: p.newDebtors,
    lineCount: p.lineCount,
    itemCount: p.items.filter((i) => !i.covered).length,
    manualCount: p.manualCount,
    debtorCount: p.debtorCount,
    manual: p.items
      .filter((i) => i.status === "MANUAL")
      .map((i) => ({ key: i.key, month: i.month, reason: i.reason ?? "", amountCents: i.amountCents, currency: i.currency ?? "EUR", reference: i.reference })),
  };
}

export const datevPlanSchema = z.object({
  objectName: z.literal("DatevPlan"),
  mode: z.enum(["PERIOD", "SUPPLEMENT"]),
  months: z.array(z.string()),
  files: z.array(fileSchema),
  issues: z.array(issueSchema),
  repeats: z.array(repeatSchema),
  newDebtors: z.number().int(),
  lineCount: z.number().int(),
  itemCount: z.number().int(),
  manualCount: z.number().int(),
  debtorCount: z.number().int(),
  manual: z.array(manualSchema),
});

export function serializeDatevStatus(s: DatevStatus) {
  return {
    objectName: "DatevStatus" as const,
    confirmed: s.confirmed,
    exportedMonths: s.exportedMonths.map((m) => ({ month: m.month, exportId: m.exportId, createdAt: iso(m.createdAt) })),
    pendingLate: s.pendingLate,
  };
}

export const datevStatusSchema = z.object({
  objectName: z.literal("DatevStatus"),
  confirmed: z.boolean(),
  exportedMonths: z.array(z.object({ month: z.string(), exportId: z.string(), createdAt: z.string().nullable() })),
  pendingLate: z.array(z.object({ month: z.string(), count: z.number().int(), amountCents: z.number().int() })).describe("Nachtraege in bereits exportierten Monaten."),
});

/** Aenderungen an den Einstellungen, die nur die Oberflaeche setzt: 400 mit festem Text. */
export const DATEV_UI_ONLY_MESSAGE = "Die Bestaetigung der Kontenzuordnung ist nur in der Oberflaeche moeglich.";
