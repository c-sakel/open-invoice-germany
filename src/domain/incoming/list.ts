/**
 * Lesende Abfragen der Eingangsrechnungen fuer REST, MCP und Oberflaeche: Liste mit Filtern und
 * Abgleich (updatedSince + Cursor) sowie die Detailansicht mit Lesefassung und letztem Pruefergebnis.
 * Jede Abfrage ist auf die Organisation begrenzt; es gibt keine Dateipfade in den Ergebnissen.
 */
import { z } from "zod";
import { ciContains, dbInternal } from "@/lib/db";
import { berlinCalendarDay, berlinDateKey, berlinDayEnd, berlinMidnight } from "@/lib/berlin-time";
import { NotFoundError } from "@/domain/errors";
import { nextSyncCursor, resolveSyncWindow, syncWhere, SYNC_ORDER_BY } from "@/domain/sync/updated-since";
import { incomingListQuerySchema, parsedIncomingInvoiceSchema, type IncomingManual, type IncomingView, type ParsedIncomingInvoice } from "@/schemas/incoming";
import type { Prisma } from "@/generated/prisma/client";
import { incomingHistory, type IncomingHistoryEntry } from "./history";
import { ibanWarning, previousSupplierIban, type IbanWarning } from "./payment-check";
import { buildPaymentInstruction, type PaymentInstruction } from "./payment-instruction";
import { parseSkontoTerms, skontoSchedule, type SkontoTerm } from "./skonto";
import { suggestSupplierContacts, type SupplierSuggestion } from "./supplier";
import { EDITABLE_STATUSES, parseManual } from "./update";
import { allowedActions, INCOMING_OPEN_STATUSES, type IncomingAction, type IncomingStatus } from "./workflow";

import { IncomingFormatError } from "./errors";
import { getIncomingFile } from "./files";
import { parseIncomingXml } from "./parse";
import { maskIban } from "@/lib/iban";
import { buildIncomingView, type IncomingViewOptions } from "./view";

import { INCOMING_HEADER_SELECT, type IncomingHeaderRow } from "./header";

const STATUS_SET: ReadonlySet<string> = new Set(["NEW", "CHECKED", "APPROVED", "PAID", "REJECTED"]);
export { INCOMING_HEADER_SELECT, type IncomingHeaderRow };

export interface IncomingListResult {
  rows: IncomingHeaderRow[];
  total: number;
  limit: number;
  offset: number;
  nextCursor?: string | null;
}

function dayRange(from: string | undefined, to: string | undefined): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const f = from ? from.split("-").map(Number) : null;
  const t = to ? to.split("-").map(Number) : null;
  return {
    ...(f ? { gte: berlinMidnight(f[0], f[1], f[2]) } : {}),
    ...(t ? { lte: berlinDayEnd(new Date(Date.UTC(t[0], t[1] - 1, t[2]))) } : {}),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 7;

/** Bedingung fuer "bald faellig" (inkl. ueberfaellig) bzw. "ueberfaellig": nur offene Stati, wirksame Faelligkeit. */
function dueWhere(kind: "DUE_SOON" | "OVERDUE", now: Date): Prisma.IncomingInvoiceWhereInput {
  const today = berlinCalendarDay(now);
  return {
    status: { in: [...INCOMING_OPEN_STATUSES] },
    dueAt: kind === "OVERDUE" ? { not: null, lt: today } : { not: null, lte: new Date(today.getTime() + DUE_SOON_DAYS * DAY_MS) },
  };
}

export async function listIncomingInvoices(orgId: string, rawFilter: unknown, now: Date = new Date()): Promise<IncomingListResult> {
  const filter = incomingListQuerySchema.parse(rawFilter ?? {});
  const sync = resolveSyncWindow(rawFilter, filter);
  const received = dayRange(filter.receivedFrom, filter.receivedTo);
  const where: Prisma.IncomingInvoiceWhereInput = {
    orgId,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.validationStatus ? { validationStatus: filter.validationStatus } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(received ? { receivedAt: received } : {}),
    ...(filter.supplierContactId ? { supplierContactId: filter.supplierContactId } : {}),
    ...(filter.due ? { AND: [dueWhere(filter.due, now)] } : {}),
    ...(filter.supplier ? { OR: [{ supplierName: ciContains(filter.supplier) }, { supplierVatId: ciContains(filter.supplier) }] } : {}),
  };
  const windowWhere: Prisma.IncomingInvoiceWhereInput = sync ? { AND: [where, syncWhere({ since: sync.since, after: null })] } : where;
  const pageWhere: Prisma.IncomingInvoiceWhereInput = sync && sync.after ? { AND: [where, syncWhere(sync)] } : windowWhere;
  const orderBy: Prisma.IncomingInvoiceOrderByWithRelationInput[] = sync ? [...SYNC_ORDER_BY] : [{ receivedAt: "desc" }, { id: "desc" }];
  const [total, rows] = await Promise.all([
    dbInternal.incomingInvoice.count({ where: windowWhere }),
    dbInternal.incomingInvoice.findMany({
      where: pageWhere,
      select: INCOMING_HEADER_SELECT,
      orderBy,
      take: filter.limit,
      ...(sync ? {} : { skip: filter.offset }),
    }),
  ]);
  return { rows, total, limit: filter.limit, offset: filter.offset, ...(sync ? { nextCursor: nextSyncCursor(rows, filter.limit) } : {}) };
}

// ── Detail ───────────────────────────────────────────────────────────────────────

const findingSchema = z.object({ ruleId: z.string(), level: z.string(), location: z.string(), text: z.string() });
export type IncomingFinding = z.infer<typeof findingSchema>;

export interface IncomingValidationHead {
  id: string;
  at: Date;
  engine: string;
  artefactVersion: string;
  result: string;
  reason: string | null;
  formatErrors: number;
  ruleErrors: number;
  warnings: number;
  durationMs: number;
}

export interface IncomingValidationDetail extends IncomingValidationHead {
  /** Formatfehler (Schema), Geschaeftsregelfehler, Hinweise/Warnungen. */
  findings: { format: IncomingFinding[]; rules: IncomingFinding[]; notes: IncomingFinding[] };
}

export interface IncomingWorkflowState {
  status: string;
  checkedAt: Date | null;
  checkedBy: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  paidMarkedAt: Date | null;
  dueAt: Date | null;
}

export interface IncomingDetail {
  header: IncomingHeaderRow;
  view: IncomingView;
  validation: IncomingValidationDetail | null;
  validations: IncomingValidationHead[];
  /** Bearbeitungsstand ohne Zahlungsvermerk. */
  workflow: IncomingWorkflowState;
  allowedActions: IncomingAction[];
  /** Herkunft bei Kanal MAILBOX (ohne Betreff und Absenderadresse). */
  mailSource: { internalDate: Date | null; fetchedAt: Date; senderDomain: string | null } | null;
  /** Interne Notiz (nur Detail, nie in Listen oder Exporten). */
  internalNote: string | null;
  /** Zahlungsvermerk (Detail; auch in REST und MCP, nie in Listen oder Exporten). */
  paidNote: string | null;
  supplierContact: { id: string; name: string; customerNumber: string | null } | null;
  manual: IncomingManual | null;
  suggestions: SupplierSuggestion[];
  skonto: { terms: SkontoTerm[]; schedule: ReturnType<typeof skontoSchedule>; freeText: string | null };
  payment: PaymentInstruction | null;
  ibanWarning: IbanWarning | null;
  history: IncomingHistoryEntry[];
}

const VALIDATION_HEAD_SELECT = {
  id: true,
  at: true,
  engine: true,
  artefactVersion: true,
  result: true,
  reason: true,
  formatErrors: true,
  ruleErrors: true,
  warnings: true,
  durationMs: true,
} as const satisfies Prisma.IncomingInvoiceValidationSelect;

export function hintCodesOf(hintsJson: string): string[] {
  try {
    const v: unknown = JSON.parse(hintsJson);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pickHead(v: IncomingValidationHead): IncomingValidationHead {
  const { id, at, engine, artefactVersion, result, reason, formatErrors, ruleErrors, warnings, durationMs } = v;
  return { id, at, engine, artefactVersion, result, reason, formatErrors, ruleErrors, warnings, durationMs };
}

function groupFindings(json: string): IncomingValidationDetail["findings"] {
  const out: IncomingValidationDetail["findings"] = { format: [], rules: [], notes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  const parsed = z.array(findingSchema).safeParse(raw);
  if (!parsed.success) return out;
  for (const f of parsed.data) (f.level === "FORMAT" ? out.format : f.level === "ERROR" ? out.rules : out.notes).push(f);
  return out;
}

export function hasInvoiceXml(row: { kind: string; originalMime: string; xmlPath: string | null }): boolean {
  return row.kind !== "OTHER" && (row.xmlPath !== null || row.originalMime === "application/xml");
}

async function readParsed(orgId: string, id: string): Promise<ParsedIncomingInvoice | null> {
  // Hash-Pruefung der archivierten Datei vor dem Lesen (Abweichung: Pflicht-Alarm, keine Ausgabe).
  const file = await getIncomingFile(orgId, id, "xml");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
    return parsedIncomingInvoiceSchema.parse(parseIncomingXml(text));
  } catch (e) {
    if (e instanceof IncomingFormatError || e instanceof TypeError || e instanceof z.ZodError) return null;
    throw e;
  }
}

export async function getIncomingInvoiceDetail(
  orgId: string,
  id: string,
  opts: Pick<IncomingViewOptions, "ibanMode" | "maxLines">,
  now: Date = new Date(),
): Promise<IncomingDetail> {
  const found =
    id.length <= 64
      ? await dbInternal.incomingInvoice.findFirst({ where: { id, orgId }, select: { ...INCOMING_HEADER_SELECT, internalNote: true, paidNote: true } })
      : null;
  if (!found) throw new NotFoundError("Eingangsrechnung nicht gefunden.");
  const { internalNote, paidNote, ...header } = found;
  const [org, parsed, latest, validations, history, mailRow] = await Promise.all([
    dbInternal.organization.findUnique({ where: { id: orgId }, select: { vatId: true } }),
    hasInvoiceXml(header) ? readParsed(orgId, id) : Promise.resolve(null),
    dbInternal.incomingInvoiceValidation.findFirst({
      where: { incomingInvoiceId: id },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      select: { ...VALIDATION_HEAD_SELECT, findingsJson: true },
    }),
    dbInternal.incomingInvoiceValidation.findMany({
      where: { incomingInvoiceId: id },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: 50,
      select: VALIDATION_HEAD_SELECT,
    }),
    incomingHistory(orgId, id),
    header.channel === "MAILBOX"
      ? dbInternal.inboundMailAttachment.findFirst({ where: { incomingInvoiceId: id, orgId }, select: { message: { select: { internalDate: true, fetchedAt: true, senderDomain: true } } } })
      : Promise.resolve(null),
  ]);
  const view = buildIncomingView({ ...header, hintCodes: hintCodesOf(header.hintsJson) }, parsed, { ...opts, ownVatId: org?.vatId ?? null });
  const validation: IncomingValidationDetail | null = latest
    ? { ...pickHead(latest), findings: groupFindings(latest.findingsJson) }
    : null;

  const manual = parseManual(header.manualJson);
  const todayBerlin = berlinDateKey(now);
  const skontoTerms = parseSkontoTerms(parsed?.payment.terms ?? null);
  const issueDay = parsed?.issueDate ?? manual?.issueDate ?? null;
  const schedule = skontoSchedule(skontoTerms.terms, issueDay, header.payableCents);

  let payment: PaymentInstruction | null = null;
  let currentIban: string | null = null;
  if (parsed) {
    const full = buildPaymentInstruction({
      currency: header.currency,
      payableCents: header.payableCents,
      typeCode: header.typeCode,
      means: parsed.payment.means,
      remittance: parsed.payment.remittance,
      number: header.number,
      sellerName: parsed.seller.name,
      payeeName: parsed.payee?.name ?? null,
      skonto: schedule,
      todayBerlin,
    });
    currentIban = full.iban;
    // REST und MCP: IBAN maskiert, keine GiroCodes (die Payload enthaelt die volle IBAN).
    payment = opts.ibanMode === "masked" ? { ...full, iban: full.iban === null ? null : maskIban(full.iban), girocodes: [] } : full;
  }

  const editable = EDITABLE_STATUSES.includes(header.status);
  const [previous, contact, suggestions] = await Promise.all([
    currentIban !== null ? previousSupplierIban(orgId, header) : Promise.resolve(null),
    header.supplierContactId !== null
      ? dbInternal.customer.findFirst({ where: { id: header.supplierContactId, orgId }, select: { id: true, name: true, customerNumber: true } })
      : Promise.resolve(null),
    header.supplierContactId === null && editable ? suggestSupplierContacts(orgId, header) : Promise.resolve([]),
  ]);
  const warn = ibanWarning(currentIban, previous);
  const ibanOut: IbanWarning | null =
    warn && warn.previous && opts.ibanMode === "masked" ? { ...warn, previous: { ...warn.previous, iban: maskIban(warn.previous.iban) } } : warn;

  return {
    header,
    view,
    validation,
    validations,
    workflow: {
      status: header.status,
      checkedAt: header.checkedAt,
      checkedBy: header.checkedBy,
      approvedAt: header.approvedAt,
      approvedBy: header.approvedBy,
      rejectedAt: header.rejectedAt,
      rejectedBy: header.rejectedBy,
      rejectReason: header.rejectReason,
      paidMarkedAt: header.paidMarkedAt,
      dueAt: header.dueAt,
    },
    mailSource: mailRow?.message ?? null,
    allowedActions: STATUS_SET.has(header.status) ? allowedActions(header.status as IncomingStatus) : [],
    internalNote,
    paidNote,
    supplierContact: contact,
    manual,
    suggestions,
    skonto: { terms: skontoTerms.terms, schedule, freeText: skontoTerms.freeText },
    payment,
    ibanWarning: ibanOut,
    history,
  };
}

/** Anzahl je Bearbeitungsstatus fuer die Reiter, dazu `DUE_SOON` (offen, faellig bis heute + 7 Tage, inkl. ueberfaellig). */
export async function countIncomingByStatus(orgId: string, now: Date = new Date()): Promise<Record<string, number>> {
  const [groups, dueSoon] = await Promise.all([
    dbInternal.incomingInvoice.groupBy({ by: ["status"], where: { orgId }, _count: { _all: true } }),
    dbInternal.incomingInvoice.count({ where: { orgId, ...dueWhere("DUE_SOON", now) } }),
  ]);
  const out: Record<string, number> = { DUE_SOON: dueSoon };
  for (const g of groups) out[g.status] = g._count._all;
  return out;
}

/** Anzahl je Pruefstatus fuer die Reiter der Oberflaeche (nur die eigene Organisation). */
export async function countIncomingByValidationStatus(orgId: string): Promise<Record<string, number>> {
  const groups = await dbInternal.incomingInvoice.groupBy({ by: ["validationStatus"], where: { orgId }, _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const g of groups) out[g.validationStatus] = g._count._all;
  return out;
}
