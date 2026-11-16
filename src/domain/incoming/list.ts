/**
 * Lesende Abfragen der Eingangsrechnungen fuer REST, MCP und Oberflaeche: Liste mit Filtern und
 * Abgleich (updatedSince + Cursor) sowie die Detailansicht mit Lesefassung und letztem Pruefergebnis.
 * Jede Abfrage ist auf die Organisation begrenzt; es gibt keine Dateipfade in den Ergebnissen.
 */
import { z } from "zod";
import { ciContains, dbInternal } from "@/lib/db";
import { berlinDayEnd, berlinMidnight } from "@/lib/berlin-time";
import { NotFoundError } from "@/domain/errors";
import { nextSyncCursor, resolveSyncWindow, syncWhere, SYNC_ORDER_BY } from "@/domain/sync/updated-since";
import { incomingListQuerySchema, parsedIncomingInvoiceSchema, type IncomingView, type ParsedIncomingInvoice } from "@/schemas/incoming";
import type { Prisma } from "@/generated/prisma/client";
import { IncomingFormatError } from "./errors";
import { getIncomingFile } from "./files";
import { parseIncomingXml } from "./parse";
import { buildIncomingView, type IncomingViewOptions } from "./view";

export const INCOMING_HEADER_SELECT = {
  id: true,
  receivedAt: true,
  channel: true,
  originalFileName: true,
  originalMime: true,
  originalSize: true,
  originalSha256: true,
  xmlPath: true,
  kind: true,
  syntax: true,
  profile: true,
  isEInvoice: true,
  typeCode: true,
  number: true,
  issueDate: true,
  dueDate: true,
  deliveryDate: true,
  currency: true,
  netCents: true,
  taxCents: true,
  grossCents: true,
  payableCents: true,
  supplierName: true,
  supplierVatId: true,
  buyerName: true,
  buyerVatId: true,
  hintsJson: true,
  validationStatus: true,
  duplicateOfId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.IncomingInvoiceSelect;
export type IncomingHeaderRow = Prisma.IncomingInvoiceGetPayload<{ select: typeof INCOMING_HEADER_SELECT }>;

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

export async function listIncomingInvoices(orgId: string, rawFilter: unknown): Promise<IncomingListResult> {
  const filter = incomingListQuerySchema.parse(rawFilter ?? {});
  const sync = resolveSyncWindow(rawFilter, filter);
  const received = dayRange(filter.receivedFrom, filter.receivedTo);
  const where: Prisma.IncomingInvoiceWhereInput = {
    orgId,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.validationStatus ? { validationStatus: filter.validationStatus } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(received ? { receivedAt: received } : {}),
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

export interface IncomingDetail {
  header: IncomingHeaderRow;
  view: IncomingView;
  validation: IncomingValidationDetail | null;
  validations: IncomingValidationHead[];
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

export async function getIncomingInvoiceDetail(orgId: string, id: string, opts: Pick<IncomingViewOptions, "ibanMode" | "maxLines">): Promise<IncomingDetail> {
  const header = id.length <= 64 ? await dbInternal.incomingInvoice.findFirst({ where: { id, orgId }, select: INCOMING_HEADER_SELECT }) : null;
  if (!header) throw new NotFoundError("Eingangsrechnung nicht gefunden.");
  const [org, parsed, latest, validations] = await Promise.all([
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
  ]);
  const view = buildIncomingView({ ...header, hintCodes: hintCodesOf(header.hintsJson) }, parsed, { ...opts, ownVatId: org?.vatId ?? null });
  const validation: IncomingValidationDetail | null = latest
    ? { ...pickHead(latest), findings: groupFindings(latest.findingsJson) }
    : null;
  return { header, view, validation, validations };
}

/** Anzahl je Pruefstatus fuer die Reiter der Oberflaeche (nur die eigene Organisation). */
export async function countIncomingByValidationStatus(orgId: string): Promise<Record<string, number>> {
  const groups = await dbInternal.incomingInvoice.groupBy({ by: ["validationStatus"], where: { orgId }, _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const g of groups) out[g.validationStatus] = g._count._all;
  return out;
}
