/**
 * Gemeinsame Bausteine fuer Uebergabe-ZIP und Pruefer-Export: ausdrueckliche Auswahl der Felder
 * (ohne interne Notiz und Zahlungsvermerk), wirksame Kopfdaten (Datei vor Hand-Kopfdaten) und
 * Dateinamen im Archivexport.
 */
import type { Prisma } from "@/generated/prisma/client";
import { berlinDateKey } from "@/lib/berlin-time";
import { parseManual } from "./update";

export const INCOMING_EXPORT_SELECT = {
  id: true,
  receivedAt: true,
  channel: true,
  originalFileName: true,
  originalMime: true,
  originalSize: true,
  originalSha256: true,
  xmlPath: true,
  xmlSha256: true,
  kind: true,
  syntax: true,
  profile: true,
  isEInvoice: true,
  typeCode: true,
  number: true,
  issueDate: true,
  dueDate: true,
  dueAt: true,
  currency: true,
  netCents: true,
  taxCents: true,
  grossCents: true,
  payableCents: true,
  supplierName: true,
  supplierVatId: true,
  supplierTaxNumber: true,
  validationStatus: true,
  status: true,
  supplierContactId: true,
  manualJson: true,
  checkedAt: true,
  checkedBy: true,
  approvedAt: true,
  approvedBy: true,
  rejectedAt: true,
  rejectedBy: true,
  rejectReason: true,
  paidMarkedAt: true,
  duplicateOf: { select: { id: true, number: true } },
} as const satisfies Prisma.IncomingInvoiceSelect;
export type IncomingExportRow = Prisma.IncomingInvoiceGetPayload<{ select: typeof INCOMING_EXPORT_SELECT }>;

export interface EffectiveHeader {
  number: string | null;
  issueDate: Date | null;
  dueAt: Date | null;
  currency: string | null;
  grossCents: number | null;
  payableCents: number | null;
  supplierName: string | null;
  manual: boolean;
}

/** Hand-Kopfdaten fuellen nur Felder, die aus der Datei leer geblieben sind. */
export function effectiveHeader(r: IncomingExportRow): EffectiveHeader {
  const m = parseManual(r.manualJson);
  const fill = <T>(file: T | null, hand: T | null | undefined): T | null => file ?? hand ?? null;
  const out: EffectiveHeader = {
    number: fill(r.number, m?.number),
    issueDate: fill(r.issueDate, m ? new Date(`${m.issueDate}T00:00:00.000Z`) : null),
    dueAt: r.dueAt,
    currency: fill(r.currency, m?.currency),
    grossCents: fill(r.grossCents, m?.grossCents),
    payableCents: fill(r.payableCents, m?.grossCents),
    supplierName: fill(r.supplierName, m?.supplierName),
    manual: false,
  };
  out.manual = m !== null && (r.number === null || r.issueDate === null || r.grossCents === null || r.supplierName === null || r.currency === null);
  return out;
}

const SAFE_EXT = /^[A-Za-z0-9]{1,5}$/;
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/xml": "xml",
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/csv": "csv",
};

/** Dateiendung der Originaldatei (aus dem Dateinamen, sonst aus dem Medientyp). */
export function originalExtension(r: { originalFileName: string; originalMime: string }): string {
  const ext = /\.([^.]+)$/.exec(r.originalFileName)?.[1];
  if (ext !== undefined && SAFE_EXT.test(ext)) return ext.toLowerCase();
  return MIME_EXT[r.originalMime] ?? "bin";
}

/** Eindeutiger Dateiname ohne Endung: `<Eingangstag>_<Nummer|Kurz-ID>`. */
export function incomingStem(r: IncomingExportRow, head: EffectiveHeader, used: Set<string>): string {
  const base = `${berlinDateKey(r.receivedAt)}_${(head.number ?? r.id.slice(0, 8)).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  let stem = base;
  if (used.has(stem.toLowerCase())) stem = `${base}-${r.id.slice(0, 8)}`;
  while (used.has(stem.toLowerCase())) stem += "_";
  used.add(stem.toLowerCase());
  return stem;
}

/** Hybrid-Rechnungen werden zusaetzlich mit der ausgelesenen XML abgelegt. */
export const hasSeparateXml = (r: IncomingExportRow): boolean => r.kind === "HYBRID" && r.xmlPath !== null && r.originalMime !== "application/xml";
