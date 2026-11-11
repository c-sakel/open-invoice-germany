/**
 * Reine Rechenlogik der OSS-Schwelle (Phase 16e, § 3c Abs. 4 UStG): Klassifikation des Kaeufers,
 * EUR-Beitrag je Beleg und Jahresaggregat. Keine Datenbankzugriffe, nur Integer-Cent.
 */
import { fxStichtag } from "../fx/pick-rate";
import { toEurCents } from "../fx/convert";
import { applyDocumentAdjustments } from "@/lib/pricing/allocate";
import { PricingError } from "@/lib/pricing/errors";
import { EU_COUNTRY_CODES } from "@/lib/tax";
import { OSS_COUNTED_CATEGORIES, type OssCategory, type OssCountMode } from "@/schemas/oss";

export const OSS_THRESHOLD_CENTS = 1_000_000;

export interface OssDoc {
  id: string;
  type: string;
  currency: string;
  issueDate: Date;
  deliveryDate: Date | null;
  deliveryEnd: Date | null;
  buyer: { countryCode: string; vatId: string | null } | null;
  netTotalCents: number;
  netTotalEurCents: number | null;
  fxRateMicros: number | null;
  documentDiscountPermille: number;
  documentDiscountCents: number;
  documentChargePermille: number;
  documentChargeCents: number;
  lines: ReadonlyArray<{ lineType: string; lineNetCents: number; ossCategory: string | null }>;
  correctsInvoiceId: string | null;
  /** Nur bei FINAL befuellt, sonst []. */
  deductedDownpaymentIds: readonly string[];
}

export type OssYearSum = {
  year: number;
  netEurCents: number;
  percent: number;
  documentCount: number;
  skippedWithoutEur: number;
  byCountry: { countryCode: string; netEurCents: number }[];
};

export type OssLevel = "OK" | "WARN" | "EXCEEDED";

/** a * b / c in BigInt, halb weg von null gerundet (Produkte koennen 2^53 ueberschreiten). c = 0 -> 0. */
function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  const neg = a < 0 !== b < 0 !== c < 0;
  const absA = BigInt(Math.abs(a));
  const absB = BigInt(Math.abs(b));
  const absC = BigInt(Math.abs(c));
  const q = (absA * absB * BigInt(2) + absC) / (BigInt(2) * absC);
  const out = Number(q);
  return neg && out !== 0 ? -out : out;
}

/** EU-Kaeufer ohne USt-IdNr. (B2C) mit Land ≠ DE laut Beleg-Snapshot. */
export function isOssBuyer(buyer: OssDoc["buyer"]): boolean {
  if (!buyer) return false;
  if (buyer.countryCode === "DE" || !EU_COUNTRY_CODES.has(buyer.countryCode)) return false;
  return buyer.vatId === null || buyer.vatId.trim() === "";
}

/** Jahr des Leistungszeitpunkts (R6): deliveryDate ?? deliveryEnd ?? issueDate, UTC. */
export function ossYearOf(doc: OssDoc): number {
  return fxStichtag(doc).getUTCFullYear();
}

function isCounted(category: string | null): boolean {
  return category !== null && OSS_COUNTED_CATEGORIES.has(category as OssCategory);
}

function toEur(doc: OssDoc, cents: number): number | null {
  if (doc.currency === "EUR") return cents;
  if (doc.fxRateMicros === null) return null;
  return toEurCents(cents, doc.fxRateMicros);
}

/** Netto-Anteil des Belegs (EUR-Cent) im Zaehlmodus; null, wenn nicht in EUR umrechenbar. */
export function ownEurCents(doc: OssDoc, mode: OssCountMode): number | null {
  if (mode === "ALL_EU_B2C") {
    if (doc.netTotalEurCents !== null) return doc.netTotalEurCents;
    return toEur(doc, doc.netTotalCents);
  }
  let ossRaw = 0;
  let otherRaw = 0;
  for (const l of doc.lines) {
    if (l.lineType !== "ITEM") continue;
    if (isCounted(l.ossCategory)) ossRaw += l.lineNetCents;
    else otherRaw += l.lineNetCents;
  }
  const noAdjustment =
    doc.documentDiscountPermille === 0 &&
    doc.documentDiscountCents === 0 &&
    doc.documentChargePermille === 0 &&
    doc.documentChargeCents === 0;
  let ossNet = ossRaw;
  if (!noAdjustment) {
    try {
      const buckets = applyDocumentAdjustments(
        [
          { key: "OSS", taxRate: 0, taxCategory: "S", netCents: ossRaw },
          { key: "OTHER", taxRate: 0, taxCategory: "S", netCents: otherRaw },
        ],
        {
          discountPermille: doc.documentDiscountPermille,
          discountCents: doc.documentDiscountCents,
          chargePermille: doc.documentChargePermille,
          chargeCents: doc.documentChargeCents,
        },
      );
      ossNet = buckets[0].adjustedNetCents;
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      ossNet = mulDivRound(ossRaw, doc.netTotalCents, ossRaw + otherRaw);
    }
  }
  return toEur(doc, ossNet);
}

function contribution(
  doc: OssDoc,
  mode: OssCountMode,
  related: ReadonlyMap<string, OssDoc>,
  followOriginal: boolean,
): number | null {
  if (doc.type === "FINAL") {
    const own = ownEurCents(doc, mode);
    if (own === null) return null;
    let deducted = 0;
    for (const id of doc.deductedDownpaymentIds) {
      // Fehlender oder nicht umrechenbarer Abschlag: nie still 0 abziehen, Beleg wird gemeldet (null).
      const dp = related.get(id);
      const dpOwn = dp ? ownEurCents(dp, mode) : null;
      if (dpOwn === null) return null;
      deducted += dpOwn;
    }
    return own - deducted;
  }
  // Gutschrift/Korrektur tragen nur Summenzeilen ohne Kategorie: Anteil des Originals uebernehmen.
  // Das Original wird nur eine Ebene weit verfolgt (followOriginal=false beim Aufruf fuer das Original),
  // das verhindert Zyklen; ein Original vom Typ Gutschrift/Korrektur faellt auf eigene Zeilen zurueck.
  if (
    followOriginal &&
    mode === "BY_PRODUCT" &&
    (doc.type === "CREDIT_NOTE" || doc.type === "CORRECTION") &&
    doc.correctsInvoiceId !== null
  ) {
    const orig = related.get(doc.correctsInvoiceId);
    if (!orig) return null; // Original nicht geladen: nie still 0, Beleg wird gemeldet
    const creditAll = ownEurCents(doc, "ALL_EU_B2C");
    const origBy = contribution(orig, "BY_PRODUCT", related, false);
    const origAll = contribution(orig, "ALL_EU_B2C", related, false);
    if (creditAll === null || origBy === null || origAll === null) return null;
    return mulDivRound(creditAll, origBy, origAll);
  }
  return ownEurCents(doc, mode);
}

/** Beitrag eines Belegs zur Jahressumme (EUR-Cent, vorzeichenbehaftet); null, wenn nicht umrechenbar. */
export function contributionEurCents(
  doc: OssDoc,
  mode: OssCountMode,
  related: ReadonlyMap<string, OssDoc>,
): number | null {
  return contribution(doc, mode, related, true);
}

export function aggregateOssYear(
  docs: readonly OssDoc[],
  related: ReadonlyMap<string, OssDoc>,
  mode: OssCountMode,
  year: number,
): OssYearSum {
  let net = 0;
  let documentCount = 0;
  let skippedWithoutEur = 0;
  const perCountry = new Map<string, number>();
  for (const doc of docs) {
    if (!isOssBuyer(doc.buyer) || ossYearOf(doc) !== year) continue;
    const c = contributionEurCents(doc, mode, related);
    if (c === null) {
      skippedWithoutEur += 1;
      continue;
    }
    net += c;
    if (c === 0) continue;
    documentCount += 1;
    const cc = doc.buyer!.countryCode;
    perCountry.set(cc, (perCountry.get(cc) ?? 0) + c);
  }
  const byCountry = [...perCountry.entries()]
    .map(([countryCode, netEurCents]) => ({ countryCode, netEurCents }))
    .filter((e) => e.netEurCents !== 0)
    .sort((a, b) => b.netEurCents - a.netEurCents || a.countryCode.localeCompare(b.countryCode));
  return {
    year,
    netEurCents: net,
    percent: Math.floor((Math.max(0, net) * 100) / OSS_THRESHOLD_CENTS),
    documentCount,
    skippedWithoutEur,
    byCountry,
  };
}

/** Strikt ueber 10.000,00 EUR im laufenden Jahr oder Vorjahr = EXCEEDED; Warnung ab warnPercent im laufenden Jahr. */
export function ossLevel(currentCents: number, previousCents: number, warnPercent: number): OssLevel {
  if (currentCents > OSS_THRESHOLD_CENTS || previousCents > OSS_THRESHOLD_CENTS) return "EXCEEDED";
  if (currentCents * 100 >= warnPercent * OSS_THRESHOLD_CENTS) return "WARN";
  return "OK";
}
