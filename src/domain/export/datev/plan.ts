/**
 * Aufbau eines Exportlaufs (Vorschau und Lauf teilen sich diesen Weg): Einstellungen und Bestaetigung pruefen,
 * Zeitraum bestimmen, Posten laden, Debitorennummern vergeben, buchen, Dateien und ZIP erzeugen. Schreibt nur
 * Debitorennummern (in der Transaktion des Aufrufers); `planDatevExport` rollt alles zurueck.
 */
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import type { Prisma } from "@/generated/prisma/client";
import { berlinMidnight, berlinMonthKey } from "@/lib/berlin-time";
import { ZipWriter } from "@/lib/zip/writer";
import { col, csvTable, CSV_BOM } from "@/domain/export/csv-writer";
import { datevExportRequestSchema, type DatevExportRequest } from "@/schemas/datev";
import {
  bookDocument,
  bookPayments,
  docItemKey,
  mappingLookup,
  paymentItemKey,
  type BookingContext,
  type BookingLine,
  type DatevIssue,
  type DocInput,
  type ItemResult,
  type PaymentInput,
} from "./bookings";
import { datevConfigHash } from "./confirm-hash";
import { debtorRow, type DebtorCustomer } from "./debtor-file";
import { assignDebtorAccountsWithinTx } from "./debtors";
import { DatevExportError } from "./errors";
import { BOOKING_FIELDS, DEBTOR_FIELDS } from "./fields";
import { datevFile, encodeCp1252, headerLine, type CellValue } from "./format";
import { exportedMonths, nextMonth, supplementCandidates } from "./late";
import { listDocRefs, listPaymentRefs, loadDocInputs, loadPaymentInputs, monthOf, monthStartOf } from "./load";
import { getDatevSettings, toConfig } from "./settings";
import type { StoredExport } from "./stored";

type Tx = Prisma.TransactionClient;

export const DATEV_MAX_MONTHS = 12;
const EMPTY_SHA = createHash("sha256").update("").digest("hex");
const NOT_CONFIRMED_MESSAGE =
  "Kontenzuordnung nicht bestaetigt — mit dem Steuerberater abstimmen und unter Einstellungen → DATEV bestaetigen";

export interface PlannedFile {
  name: string;
  kind: "BOOKINGS" | "DEBTORS" | "PROTOCOL";
  month: string | null;
  lineCount: number;
  sha256: string;
  contentSha256: string;
}

export interface PlannedItem {
  key: string;
  status: "EXPORTED" | "MANUAL" | "EMPTY";
  month: string;
  lineCount: number;
  /** EUR-Cent, vorzeichenbehaftet. */
  amountCents: number;
  reason: string | null;
  warning: string | null;
  invoiceId: string | null;
  paymentId: string | null;
  customerId: string | null;
  /** Belegnummer bzw. Nummer der Rechnung der Zahlung. */
  reference: string;
  /** Von einer anderen Buchung mitgebucht (Skonto im Skontofeld der Zahlung); zaehlt nicht als eigener Posten. */
  covered: boolean;
}

export interface DatevRepeat {
  month: string;
  exportId: string;
  createdAt: Date;
  /** Pruefsumme des frueheren Stapels dieses Monats. */
  contentSha256: string;
  /** Neuer Inhalt gleich dem frueheren (null, solange keine Dateien entstehen konnten). */
  identical: boolean | null;
}

export interface DatevPlan {
  mode: "PERIOD" | "SUPPLEMENT";
  months: string[];
  files: PlannedFile[];
  items: PlannedItem[];
  issues: DatevIssue[];
  repeats: DatevRepeat[];
  newDebtors: number;
  lineCount: number;
  manualCount: number;
  debtorCount: number;
}

export interface BuiltRun {
  plan: DatevPlan;
  zip: Buffer | null;
  settingsJson: string;
  stored: StoredExport;
}

export function parseExportRequest(raw: unknown): DatevExportRequest {
  const r = datevExportRequestSchema.safeParse(raw);
  if (!r.success) throw new DatevExportError("INVALID_PERIOD", r.error.issues.map((i) => `${i.path.join(".") || "Eingabe"}: ${i.message}`).join("; "));
  return r.data;
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Inhalt ohne Kopfzeile (Zeitstempel im Kopf soll den Vergleich nicht stoeren). */
function contentSha(file: Buffer): string {
  const nl = file.indexOf("\r\n");
  return sha(nl < 0 ? file : file.subarray(nl + 2));
}

/** Beginn des Wirtschaftsjahres, das `month` enthaelt. */
function fiscalYearStart(month: string, startMonth: number): Date {
  const [y, m] = month.split("-").map(Number);
  return berlinMidnight(m >= startMonth ? y : y - 1, startMonth, 1);
}

/** Sachkonten werden auf die eingestellte Kontenlaenge mit Nullen aufgefuellt (Vorlagen sind 4-stellig). */
function padAccount(account: number, length: number): number {
  const digits = String(account).length;
  if (digits > length) throw new DatevExportError("ACCOUNT_TOO_LONG", `Konto ${account} ist laenger als die Sachkontenlaenge ${length}.`);
  return account * 10 ** (length - digits);
}

function paddedCells(line: BookingLine, length: number): ReadonlyMap<number, CellValue> {
  const cells = new Map(line.cells);
  cells.set(8, padAccount(line.counterAccount, length));
  return cells;
}

function mergeIssues(issues: readonly DatevIssue[]): DatevIssue[] {
  const groups = new Map<string, DatevIssue>();
  for (const i of issues) {
    const id = `${i.code}|${i.key ?? i.message}`;
    const g = groups.get(id);
    if (!g) {
      const message =
        i.key && i.code === "MISSING_MAPPING"
          ? `Kein Konto zugeordnet fuer ${i.key}`
          : i.key && i.code === "MISSING_TRANSIT"
            ? `Kein Geldtransitkonto zugeordnet fuer ${i.key}`
            : i.message;
      groups.set(id, { code: i.code, message, ...(i.key ? { key: i.key } : {}), documents: [...(i.documents ?? [])] });
    } else {
      for (const d of i.documents ?? []) if (!g.documents?.includes(d)) g.documents?.push(d);
    }
  }
  return [...groups.values()].sort((a, b) => (a.code + (a.key ?? a.message) < b.code + (b.key ?? b.message) ? -1 : 1));
}

async function collectZip(entries: { name: string; data: Buffer }[], modified: Date): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const zip = new ZipWriter(out, modified);
  for (const e of entries) await zip.addFile(e.name, e.data);
  await zip.finish();
  return Buffer.concat(chunks);
}

interface ProtocolRow {
  art: string;
  key: string;
  month: string;
  status: string;
  reference: string;
  amountCents: number | null;
  lines: number | null;
  note: string;
}

const PROTOCOL_COLUMNS = [
  col<ProtocolRow>("Art", "text", (r) => r.art),
  col<ProtocolRow>("Schluessel", "text", (r) => r.key),
  col<ProtocolRow>("Monat", "text", (r) => r.month),
  col<ProtocolRow>("Status", "text", (r) => r.status),
  col<ProtocolRow>("Referenz", "text", (r) => r.reference),
  col<ProtocolRow>("Betrag EUR", "cents", (r) => r.amountCents),
  col<ProtocolRow>("Zeilen", "int", (r) => r.lines),
  col<ProtocolRow>("Grund/Hinweis", "text", (r) => r.note),
];

function monthLabel(month: string): string {
  // Bezeichnung erlaubt kein "-" (Ausdruck [\w.-/ ]): Punkt als Trenner.
  return `${month.slice(5, 7)}.${month.slice(0, 4)}`;
}

/**
 * Baut den Lauf in der Transaktion `tx` (Organisationssperre haelt der Aufrufer). Wirft bei fehlender Bestaetigung
 * und ungueltigem Zeitraum; Buchungsfehler (fehlende Konten) stehen in `plan.issues`, dann entstehen keine Dateien.
 */
export async function buildDatevRun(tx: Tx, orgId: string, req: DatevExportRequest, now: Date): Promise<BuiltRun> {
  const settings = await getDatevSettings(orgId, tx);
  if (!settings.exists || !settings.confirmed) throw new DatevExportError("NOT_CONFIRMED", NOT_CONFIRMED_MESSAGE);
  const { consultantNumber, clientNumber, chartOfAccounts } = settings;
  if (consultantNumber === null || clientNumber === null || (chartOfAccounts !== "SKR03" && chartOfAccounts !== "SKR04")) {
    throw new DatevExportError("NOT_CONFIRMED", NOT_CONFIRMED_MESSAGE);
  }

  if (req.from > req.to) throw new DatevExportError("INVALID_PERIOD", "Der Zeitraum beginnt nach seinem Ende.");
  const requested = monthsBetween(req.from, req.to);
  if (requested.length > DATEV_MAX_MONTHS) throw new DatevExportError("INVALID_PERIOD", `Hoechstens ${DATEV_MAX_MONTHS} Monate je Export.`);
  if (req.to >= berlinMonthKey(now)) throw new DatevExportError("INVALID_PERIOD", "Nur abgeschlossene Monate koennen exportiert werden.");

  const coverage = await exportedMonths(tx, orgId);
  const months = req.mode === "PERIOD" ? requested : requested.filter((m) => coverage.has(m));
  const monthSet = new Set(months);

  const repeats: DatevRepeat[] = [];
  const plan: DatevPlan = { mode: req.mode, months, files: [], items: [], issues: [], repeats, newDebtors: 0, lineCount: 0, manualCount: 0, debtorCount: 0 };
  const stored: StoredExport = { files: [], monthHashes: {}, repeats: [], manual: [] };
  const mappingRows = await tx.datevAccountMapping.findMany({ where: { orgId }, select: { kind: true, key: true, account: true, buKey: true } });
  const config = toConfig(settings);
  const settingsJson = JSON.stringify({ ...config, configHash: datevConfigHash(config, mappingRows), confirmedAt: settings.confirmedAt?.toISOString() ?? null });
  const built: BuiltRun = { plan, zip: null, settingsJson, stored };

  if (months.length === 0) return built;

  // Posten bestimmen.
  let docIds: string[];
  let paymentIds: string[];
  if (req.mode === "PERIOD") {
    const from = monthStartOf(months[0]);
    const to = monthStartOf(months[months.length - 1], 1);
    docIds = (await listDocRefs(tx, orgId, from, to, now)).filter((d) => monthSet.has(monthOf(d.issueDate))).map((d) => d.id);
    paymentIds = settings.exportPayments
      ? (await listPaymentRefs(tx, orgId, from, to, now)).filter((p) => monthSet.has(monthOf(p.paidAt))).map((p) => p.id)
      : [];
  } else {
    const cand = await supplementCandidates(tx, orgId, monthSet, settings.exportPayments, settings.exportPaymentsSince, coverage, now);
    docIds = cand.docs.map((d) => d.id);
    paymentIds = cand.payments.map((p) => p.id);
  }
  const docs = await loadDocInputs(tx, orgId, docIds);
  const payments = await loadPaymentInputs(tx, orgId, paymentIds);
  const docByKey = new Map<string, DocInput>(docs.map((d) => [docItemKey(d.id), d]));
  const payByKey = new Map<string, PaymentInput>(payments.map((p) => [paymentItemKey(p.id), p]));

  // Wiederholungen (nur Zeitraum-Modus).
  if (req.mode === "PERIOD") {
    for (const m of months) {
      const prior = coverage.get(m);
      if (prior) repeats.push({ month: m, exportId: prior.exportId, createdAt: prior.createdAt, contentSha256: prior.contentSha256 ?? EMPTY_SHA, identical: null });
    }
  }

  // Debitorennummern.
  const customerIds = [...new Set([...docs.map((d) => d.customerId), ...payments.map((p) => p.customerId)])];
  if (settings.debtorMode === "PERSONAL" && customerIds.length > 0) {
    plan.newDebtors = await tx.customer.count({ where: { orgId, id: { in: customerIds }, datevAccount: null } });
  }
  const accounts = await assignDebtorAccountsWithinTx(tx, orgId, customerIds, settings);
  const ctx: BookingContext = { settings, mapping: mappingLookup(mappingRows), debtorOf: (id) => accounts.get(id) ?? null };

  // Buchen.
  const results: ItemResult[] = [];
  const issues: DatevIssue[] = [];
  for (const d of docs) {
    const r = bookDocument(d, ctx);
    if (Array.isArray(r)) issues.push(...r);
    else results.push(r);
  }
  if (settings.exportPayments) {
    for (const r of bookPayments(payments, ctx)) {
      if (Array.isArray(r)) issues.push(...r);
      else results.push(r);
    }
  }
  if (issues.length > 0) {
    plan.issues = mergeIssues(issues);
    return built;
  }

  const dateOf = (key: string): number => docByKey.get(key)?.issueDate.getTime() ?? payByKey.get(key)?.paidAt.getTime() ?? 0;
  results.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    const ad = a.key.startsWith("doc:") ? 0 : 1;
    const bd = b.key.startsWith("doc:") ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const dt = dateOf(a.key) - dateOf(b.key);
    if (dt !== 0) return dt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  // Posten und Zeilen je Monat.
  const rowsByMonth = new Map<string, ReadonlyMap<number, CellValue>[]>();
  const debtorCustomers = new Set<string>();
  const protocol: ProtocolRow[] = [];
  for (const r of results) {
    const doc = docByKey.get(r.key);
    const pay = payByKey.get(r.key);
    const customerId = doc?.customerId ?? pay?.customerId ?? null;
    const reference = doc?.number ?? pay?.invoiceNumber ?? "";
    const base = {
      key: r.key,
      month: r.month,
      invoiceId: doc?.id ?? pay?.invoiceId ?? null,
      paymentId: pay?.id ?? null,
      customerId,
      reference,
      covered: false,
    };
    if (r.status === "EXPORTED") {
      const rows = rowsByMonth.get(r.month) ?? [];
      for (const line of r.lines) rows.push(paddedCells(line, settings.accountLength));
      rowsByMonth.set(r.month, rows);
      if (customerId) debtorCustomers.add(customerId);
      const signed = pay?.kind === "REVERSAL" ? -Math.abs(r.amountCents) : r.amountCents;
      plan.items.push({ ...base, status: "EXPORTED", lineCount: r.lines.length, amountCents: signed, reason: null, warning: r.warning ?? null });
      plan.lineCount += r.lines.length;
      for (const k of r.coveredKeys ?? []) {
        if (k === r.key) continue;
        const cp = payByKey.get(k);
        plan.items.push({
          key: k, month: monthOf(cp?.paidAt ?? now), invoiceId: cp?.invoiceId ?? null, paymentId: cp?.id ?? null, customerId: cp?.customerId ?? null,
          reference: cp?.invoiceNumber ?? reference, covered: true, status: "EXPORTED", lineCount: 0,
          amountCents: cp ? (cp.kind === "REVERSAL" ? -Math.abs(cp.amountCents) : Math.abs(cp.amountCents)) : 0,
          reason: null, warning: "Skonto im Skontofeld der Zahlung gebucht",
        });
      }
      protocol.push({ art: pay ? "Zahlung" : "Beleg", key: r.key, month: r.month, status: "EXPORTED", reference, amountCents: signed, lines: r.lines.length, note: r.warning ?? "" });
    } else if (r.status === "MANUAL") {
      plan.items.push({ ...base, status: "MANUAL", lineCount: 0, amountCents: r.amountCents, reason: r.reason, warning: null });
      plan.manualCount += 1;
      stored.manual.push({ key: r.key, month: r.month, reason: r.reason, amountCents: r.amountCents, reference });
      protocol.push({ art: pay ? "Zahlung" : "Beleg", key: r.key, month: r.month, status: "MANUAL", reference, amountCents: r.amountCents, lines: 0, note: r.reason });
    } else {
      plan.items.push({ ...base, status: "EMPTY", lineCount: 0, amountCents: 0, reason: null, warning: null });
      protocol.push({ art: pay ? "Zahlung" : "Beleg", key: r.key, month: r.month, status: "EMPTY", reference, amountCents: 0, lines: 0, note: "Keine buchbaren Betraege" });
    }
  }
  if (results.length === 0) return built;

  const entries: { name: string; data: Buffer }[] = [];
  const addFile = (name: string, kind: PlannedFile["kind"], month: string | null, lineCount: number, data: Buffer): void => {
    const file: PlannedFile = { name, kind, month, lineCount, sha256: sha(data), contentSha256: contentSha(data) };
    plan.files.push(file);
    stored.files.push(file);
    entries.push({ name, data });
  };
  const suffix = req.mode === "SUPPLEMENT" ? "_Nachtrag" : "";
  const monthContent = new Map<string, string>();
  for (const m of [...rowsByMonth.keys()].sort()) {
    const rows = rowsByMonth.get(m) ?? [];
    const header = headerLine({
      category: 21,
      createdAt: now,
      consultantNumber,
      clientNumber,
      fiscalYearStart: fiscalYearStart(m, settings.fiscalYearStartMonth),
      accountLength: settings.accountLength,
      periodFrom: monthStartOf(m),
      periodTo: new Date(monthStartOf(m, 1).getTime() - 1),
      label: `${req.mode === "SUPPLEMENT" ? "Nachtrag" : "Rechnungsausgang"} ${monthLabel(m)}`,
      dictationCode: settings.dictationCode,
      lockBatch: settings.lockBatch,
      chart: chartOfAccounts,
    });
    const data = datevFile(header, BOOKING_FIELDS, rows);
    addFile(`EXTF_Buchungsstapel_${m}${suffix}.csv`, "BOOKINGS", m, rows.length, data);
    monthContent.set(m, contentSha(data));
  }
  for (const m of months) stored.monthHashes[m] = monthContent.get(m) ?? EMPTY_SHA;
  for (const rep of repeats) rep.identical = rep.contentSha256 === (stored.monthHashes[rep.month] ?? EMPTY_SHA);

  // Debitorendatei.
  if (settings.debtorMode === "PERSONAL" && settings.exportDebtors && debtorCustomers.size > 0) {
    const customers = await tx.customer.findMany({
      where: { orgId, id: { in: [...debtorCustomers] } },
      select: { id: true, type: true, name: true, customerNumber: true, vatId: true, addressLine1: true, addressLine2: true, postalCode: true, city: true, countryCode: true },
    });
    const rows = customers
      .map((c: DebtorCustomer) => ({ c, account: accounts.get(c.id) ?? 0 }))
      .sort((a, b) => a.account - b.account)
      .map(({ c, account }) => ({ c, row: debtorRow(c, account) }));
    const header = headerLine({
      category: 16,
      createdAt: now,
      consultantNumber,
      clientNumber,
      fiscalYearStart: fiscalYearStart(months[0], settings.fiscalYearStartMonth),
      accountLength: settings.accountLength,
      dictationCode: settings.dictationCode,
      lockBatch: settings.lockBatch,
      chart: chartOfAccounts,
    });
    const lines = [header, DEBTOR_FIELDS.map((f) => f.name).join(";"), ...rows.map((x) => x.row.line)];
    const data = encodeCp1252(lines.map((l) => `${l}\r\n`).join(""));
    addFile("EXTF_Debitoren.csv", "DEBTORS", null, rows.length, data);
    plan.debtorCount = rows.length;
    for (const { c, row } of rows) {
      for (const note of row.notes) {
        protocol.push({ art: "Debitor", key: `debtor:${c.id}`, month: "", status: "HINWEIS", reference: String(row.account), amountCents: null, lines: null, note });
      }
    }
  } else if (settings.debtorMode === "PERSONAL") {
    plan.debtorCount = 0;
  }

  const protocolData = Buffer.from(CSV_BOM + csvTable(PROTOCOL_COLUMNS, protocol), "utf8");
  addFile("protokoll.csv", "PROTOCOL", null, protocol.length, protocolData);

  for (const rep of repeats) {
    stored.repeats.push({ month: rep.month, exportId: rep.exportId, createdAt: rep.createdAt.toISOString(), contentSha256: rep.contentSha256, identical: rep.identical });
  }
  built.zip = await collectZip(entries, now);
  return built;
}

/** Vorschau: baut den Lauf ohne irgendetwas zu schreiben (Transaktion wird zurueckgerollt). */
export async function planDatevExport(orgId: string, rawReq: unknown, now: Date = new Date()): Promise<DatevPlan> {
  const req = parseExportRequest(rawReq);
  class Rollback extends Error {
    constructor(public readonly plan: DatevPlan) {
      super("rollback");
    }
  }
  try {
    await dbInternal.$transaction(
      async (tx) => {
        await lockOrganization(tx, orgId);
        const built = await buildDatevRun(tx, orgId, req, now);
        throw new Rollback(built.plan);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (e instanceof Rollback) return e.plan;
    throw e;
  }
  throw new Error("unreachable");
}

