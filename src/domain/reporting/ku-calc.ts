/**
 * Reine Rechenlogik der Umsatzgrenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG): Netto-Beitrag
 * von Belegen und Zahlungen in EUR-Cent und Jahresaggregat. Keine Datenbankzugriffe, nur Integer-Cent.
 * Massgeblich ist der vereinnahmte Umsatz; der berechnete Umsatz dient als Vorwarnung.
 */
import { berlinYear } from "@/lib/berlin-time";

export const KU_PREVIOUS_YEAR_LIMIT_CENTS = 2_500_000; // § 19 Abs. 1 S. 1 UStG
export const KU_CURRENT_YEAR_LIMIT_CENTS = 10_000_000;
/** Im Inland nicht steuerbare Umsaetze zaehlen nicht mit. */
export const KU_EXCLUDED_SCHEMES = ["IG_LEISTUNG", "NICHT_STEUERBAR"] as const;

export interface KuDoc {
  id: string;
  type: string;
  taxScheme: string;
  currency: string;
  issueDate: Date;
  netTotalCents: number;
  grossTotalCents: number;
  netTotalEurCents: number | null;
  /** Nur bei Schlussrechnungen gesetzt (Brutto abzueglich Abschlaege). */
  payableCents?: number | null;
}

export interface KuPayment {
  invoiceId: string;
  amountCents: number;
  paidAt: Date;
  isSkonto: boolean;
  method: string;
}

export type KuLevel = "OK" | "WARN" | "NEXT_YEAR_LOST" | "EXCEEDED";
export type KuReason =
  | "APPROACHING_LIMIT"
  | "APPROACHING_NEXT_YEAR_LIMIT"
  | "INVOICED_OVER_LIMIT"
  | "CURRENT_OVER_25000"
  | "CURRENT_OVER_LIMIT"
  | "PREVIOUS_OVER_25000";

export interface KuYearSum {
  year: number;
  receivedCents: number;
  invoicedCents: number;
  externalCents: number;
  totalReceivedCents: number;
  totalInvoicedCents: number;
  documentCount: number;
  skippedWithoutEur: number;
}

/** a * b / c in BigInt, halb weg von null gerundet. c = 0 -> 0. */
function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  const neg = a < 0 !== b < 0 !== c < 0;
  const absC = BigInt(Math.abs(c));
  const q = (BigInt(Math.abs(a)) * BigInt(Math.abs(b)) * BigInt(2) + absC) / (BigInt(2) * absC);
  const out = Number(q);
  return neg && out !== 0 ? -out : out;
}

function isExcluded(doc: KuDoc): boolean {
  return (KU_EXCLUDED_SCHEMES as readonly string[]).includes(doc.taxScheme);
}

/** Netto in EUR: EUR-Beleg = netTotalCents, sonst der beim Festschreiben festgehaltene EUR-Wert (null, wenn keiner). */
export function netEurOf(doc: KuDoc): number | null {
  if (doc.currency === "EUR") return doc.netTotalCents;
  return doc.netTotalEurCents;
}

/** Nettoanteil einer Zahlung in EUR-Cent (Zahlungsbetrag x Netto / Brutto des Belegs); null ohne EUR-Wert. */
export function paymentNetEurCents(p: KuPayment, doc: KuDoc): number | null {
  const net = netEurOf(doc);
  if (net === null) return null;
  return mulDivRound(p.amountCents, net, doc.grossTotalCents);
}

/** Vorzeichenbehafteter Netto-Beitrag eines Belegs zum berechneten Umsatz (Gutschriften immer negativ). */
function invoicedContribution(doc: KuDoc): number | null {
  const net = netEurOf(doc);
  if (net === null) return null;
  let value = net;
  // Schlussrechnung: um bereits berechnete Abschlaege vermindert, sonst doppelt gezaehlt. Der Anteil net * payable / gross
  // ist bei gemischten Steuersaetzen eine Naeherung (Abschlaege werden nicht je Steuersatz zugeordnet).
  if (doc.type === "FINAL" && doc.payableCents != null && doc.grossTotalCents !== 0) {
    value = mulDivRound(net, doc.payableCents, doc.grossTotalCents);
  }
  return doc.type === "CREDIT_NOTE" ? -Math.abs(value) : value;
}

export function aggregateKuYear(
  docs: readonly KuDoc[],
  payments: readonly KuPayment[],
  external: Record<string, number>,
  year: number,
): KuYearSum {
  const byId = new Map<string, KuDoc>(docs.map((d) => [d.id, d]));
  let invoiced = 0;
  let received = 0;
  const counted = new Set<string>();
  const skipped = new Set<string>();

  for (const doc of docs) {
    if (isExcluded(doc) || berlinYear(doc.issueDate) !== year) continue;
    const c = invoicedContribution(doc);
    if (c === null) {
      skipped.add(doc.id);
      continue;
    }
    invoiced += c;
    if (c !== 0) counted.add(doc.id);
  }

  for (const p of payments) {
    if (p.isSkonto || p.method === "CREDIT_NOTE" || p.method === "SKONTO") continue;
    if (berlinYear(p.paidAt) !== year) continue;
    const doc = byId.get(p.invoiceId);
    if (!doc || isExcluded(doc)) continue;
    const c = paymentNetEurCents(p, doc);
    if (c === null) {
      skipped.add(doc.id);
      continue;
    }
    received += c;
    if (c !== 0) counted.add(doc.id);
  }

  const externalCents = external[String(year)] ?? 0;
  return {
    year,
    receivedCents: received,
    invoicedCents: invoiced,
    externalCents,
    totalReceivedCents: received + externalCents,
    totalInvoicedCents: invoiced + externalCents,
    documentCount: counted.size,
    skippedWithoutEur: skipped.size,
  };
}

export function kuLevel(i: { current: KuYearSum; previous: KuYearSum; warnPercent: number; startYear: number | null }): {
  level: KuLevel;
  reasons: KuReason[];
  currentLimitCents: number;
} {
  const foundingYear = i.startYear !== null && i.startYear === i.current.year;
  const currentLimitCents = foundingYear ? KU_PREVIOUS_YEAR_LIMIT_CENTS : KU_CURRENT_YEAR_LIMIT_CENTS;
  const reasons: KuReason[] = [];

  if (!foundingYear && i.previous.totalReceivedCents > KU_PREVIOUS_YEAR_LIMIT_CENTS) reasons.push("PREVIOUS_OVER_25000");
  if (i.current.totalReceivedCents > currentLimitCents) reasons.push("CURRENT_OVER_LIMIT");
  if (reasons.length > 0) return { level: "EXCEEDED", reasons, currentLimitCents };

  if (i.current.totalReceivedCents > KU_PREVIOUS_YEAR_LIMIT_CENTS) {
    // Die Vorwarnung vor dem Wegfall mitten im Jahr (Grenze des laufenden Jahres) bleibt auch danach sichtbar.
    const lostReasons: KuReason[] = ["CURRENT_OVER_25000"];
    const lostPeak = Math.max(i.current.totalReceivedCents, i.current.totalInvoicedCents);
    if (lostPeak * 100 >= i.warnPercent * currentLimitCents) lostReasons.push("APPROACHING_LIMIT");
    if (i.current.totalInvoicedCents > currentLimitCents) lostReasons.push("INVOICED_OVER_LIMIT");
    return { level: "NEXT_YEAR_LOST", reasons: lostReasons, currentLimitCents };
  }

  const peak = Math.max(i.current.totalReceivedCents, i.current.totalInvoicedCents);
  if (peak * 100 >= i.warnPercent * currentLimitCents) reasons.push("APPROACHING_LIMIT");
  if (currentLimitCents !== KU_PREVIOUS_YEAR_LIMIT_CENTS && peak * 100 >= i.warnPercent * KU_PREVIOUS_YEAR_LIMIT_CENTS) {
    reasons.push("APPROACHING_NEXT_YEAR_LIMIT");
  }
  if (i.current.totalInvoicedCents > currentLimitCents) reasons.push("INVOICED_OVER_LIMIT");
  return { level: reasons.length > 0 ? "WARN" : "OK", reasons, currentLimitCents };
}
