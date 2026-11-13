/**
 * Auswertung der OSS-Schwelle (Phase 16e, § 3c Abs. 4 UStG). Rein lesend, org-gescoped. Liest
 * festgeschriebene Belege des Vorjahrs und des Auswertungsjahres samt Bezugsbelegen (Original einer
 * Gutschrift, Abschlaege einer Schlussrechnung); die Rechenlogik liegt in `oss-calc.ts`.
 */
import { dbInternal } from "@/lib/db";
import { loadDocumentSettings } from "@/domain/document/settings";
import { buyerSnapshotSchema } from "@/schemas";
import { OSS_NOTICE, type OssCountMode } from "@/schemas/oss";
import { aggregateOssYear, ossLevel, OSS_THRESHOLD_CENTS, type OssDoc, type OssLevel, type OssYearSum } from "./oss-calc";
import { berlinYearStart } from "@/lib/berlin-time";

export type OssThreshold = {
  thresholdCents: number;
  warnPercent: number;
  mode: OssCountMode;
  level: OssLevel;
  previousYearExceeded: boolean;
  current: OssYearSum;
  previous: OssYearSum;
  notice: string;
};

function docSelect(withLines: boolean) {
  return {
    id: true,
    type: true,
    currency: true,
    issueDate: true,
    deliveryDate: true,
    deliveryEnd: true,
    buyerSnapshotJson: true,
    netTotalCents: true,
    netTotalEurCents: true,
    fxRateMicros: true,
    documentDiscountPermille: true,
    documentDiscountCents: true,
    documentChargePermille: true,
    documentChargeCents: true,
    correctsInvoiceId: true,
    // Positionen nur im Modus BY_PRODUCT noetig (take 0 -> leere Liste, gleicher Ergebnistyp).
    lines: { select: { lineType: true, lineNetCents: true, ossCategory: true }, take: withLines ? undefined : 0 },
    finalDeductions: { select: { downpaymentInvoiceId: true } },
  } as const;
}

type OssRow = NonNullable<Awaited<ReturnType<typeof loadRows>>>[number];

function loadRows(where: Record<string, unknown>, withLines: boolean) {
  return dbInternal.invoice.findMany({ where, select: docSelect(withLines) });
}

function toDoc(row: OssRow): OssDoc {
  let buyer: OssDoc["buyer"] = null;
  if (row.buyerSnapshotJson) {
    try {
      const parsed = buyerSnapshotSchema.safeParse(JSON.parse(row.buyerSnapshotJson));
      if (parsed.success) buyer = { countryCode: parsed.data.countryCode, vatId: parsed.data.vatId };
    } catch {
      buyer = null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    currency: row.currency,
    issueDate: row.issueDate,
    deliveryDate: row.deliveryDate,
    deliveryEnd: row.deliveryEnd,
    buyer,
    netTotalCents: row.netTotalCents,
    netTotalEurCents: row.netTotalEurCents,
    fxRateMicros: row.fxRateMicros,
    documentDiscountPermille: row.documentDiscountPermille,
    documentDiscountCents: row.documentDiscountCents,
    documentChargePermille: row.documentChargePermille,
    documentChargeCents: row.documentChargeCents,
    lines: row.lines,
    correctsInvoiceId: row.correctsInvoiceId,
    deductedDownpaymentIds: [...new Set(row.finalDeductions.map((d) => d.downpaymentInvoiceId))],
  };
}

function referencedIds(docs: Iterable<OssDoc>): Set<string> {
  const ids = new Set<string>();
  for (const d of docs) {
    if (d.correctsInvoiceId) ids.add(d.correctsInvoiceId);
    for (const id of d.deductedDownpaymentIds) ids.add(id);
  }
  return ids;
}

export async function ossThreshold(orgId: string, year: number): Promise<OssThreshold> {
  const settings = await loadDocumentSettings(orgId);
  const mode = settings.ossCountMode;
  const withLines = mode === "BY_PRODUCT";
  const start = berlinYearStart(year - 1);
  const end = berlinYearStart(year + 1);
  const range = { gte: start, lt: end };

  const mainRows = await loadRows(
    { orgId, status: { not: "DRAFT" }, OR: [{ issueDate: range }, { deliveryDate: range }, { deliveryEnd: range }] },
    withLines,
  );
  const docs = mainRows.map(toDoc);

  // Bezugsbelege (Hauptbelege ebenfalls): hoechstens zwei Runden, z. B. Gutschrift -> Schlussrechnung -> Abschlaege.
  const related = new Map<string, OssDoc>(docs.map((d) => [d.id, d]));
  let frontier: Iterable<OssDoc> = docs;
  for (let round = 0; round < 2; round += 1) {
    const missing = [...referencedIds(frontier)].filter((id) => !related.has(id));
    if (missing.length === 0) break;
    const rows = await loadRows({ orgId, id: { in: missing } }, withLines);
    const loaded = rows.map(toDoc);
    for (const d of loaded) related.set(d.id, d);
    frontier = loaded;
  }

  const current = aggregateOssYear(docs, related, mode, year);
  const previous = aggregateOssYear(docs, related, mode, year - 1);
  return {
    thresholdCents: OSS_THRESHOLD_CENTS,
    warnPercent: settings.ossWarnPercent,
    mode,
    level: ossLevel(current.netEurCents, previous.netEurCents, settings.ossWarnPercent),
    previousYearExceeded: previous.netEurCents > OSS_THRESHOLD_CENTS,
    current,
    previous,
    notice: OSS_NOTICE,
  };
}
