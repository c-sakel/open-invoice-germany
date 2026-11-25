import { skontoTerms, type SkontoTerm } from "@/lib/pricing/skonto";

/**
 * Offener Betrag einer Rechnung (brutto). Phase 5 (§13-15 UStG): eine Schlussrechnung
 * traegt in `payableCents` den um die Abschlaege bereits reduzierten Restbetrag
 * (`grossTotalCents - prepaidCents`) — Zahlungen, PAID-Grenze und Skonto-Basis muessen
 * sich darauf beziehen, nicht auf `grossTotalCents` (sonst waere der Abschlag doppelt
 * gefordert). Bei allen anderen Rechnungstypen ist `payableCents` NULL und der offene
 * Betrag bezieht sich unveraendert auf `grossTotalCents` (COALESCE-Semantik, siehe
 * Prisma-Schema-Kommentar auf `Invoice.payableCents`).
 */
export interface OpenAmountInvoice {
  grossTotalCents: number;
  paidAmountCents: number;
  payableCents: number | null;
}

/** Bemessungsgrundlage fuer Zahlungen/PAID-Grenze/Skonto: `payableCents ?? grossTotalCents`. */
export function payableBaseCents(invoice: Pick<OpenAmountInvoice, "grossTotalCents" | "payableCents">): number {
  return invoice.payableCents ?? invoice.grossTotalCents;
}

/**
 * Skonto-Basis (brutto): beim Festschreiben eingefrorener Wert, sonst die Zahlungsgrundlage.
 * NULL bedeutet Zahlbetrag (`payableBaseCents`).
 */
export function skontoBaseCents(
  invoice: Pick<OpenAmountInvoice, "grossTotalCents" | "payableCents"> & { skontoBaseCents?: number | null },
): number {
  return invoice.skontoBaseCents ?? payableBaseCents(invoice);
}

export interface SkontoInvoice extends Pick<OpenAmountInvoice, "grossTotalCents" | "payableCents"> {
  skontoBaseCents?: number | null;
  issueDate: Date;
  skonto1Permille: number | null;
  skonto1Days: number | null;
  skonto2Permille: number | null;
  skonto2Days: number | null;
}

/**
 * Skonto-Fristen einer Rechnung auf der Skonto-Basis (`skontoBaseCents`). Liegt die eingefrorene Basis
 * ueber dem Zahlbetrag (Bestand: Schlussrechnung mit Basis = Gesamtbrutto), ist der Skonto-Zahlbetrag
 * der noch offene Betrag minus Skontobetrag, damit Zahlungserkennung und Bankabgleich weiter greifen.
 */
export function skontoTermsForInvoice(invoice: SkontoInvoice, openBeforeCents: number): SkontoTerm[] {
  const base = skontoBaseCents(invoice);
  const terms = skontoTerms({
    issueDate: invoice.issueDate,
    grossTotalCents: base,
    skonto1Permille: invoice.skonto1Permille,
    skonto1Days: invoice.skonto1Days,
    skonto2Permille: invoice.skonto2Permille,
    skonto2Days: invoice.skonto2Days,
  });
  if (base <= payableBaseCents(invoice)) return terms;
  // Nie ein negativer Zahlbetrag: ist der offene Rest (z. B. nach Teilzahlung) kleiner als der Skontobetrag,
  // gibt es fuer diese Frist keinen Skonto-Vorschlag.
  return terms
    .map((t) => ({ ...t, payableCents: openBeforeCents - t.amountCents }))
    .filter((t) => t.payableCents >= 0);
}

/** Offener Rest (brutto) = Bemessungsgrundlage minus bereits erfasste Zahlungen. */
export function openAmountCents(invoice: OpenAmountInvoice): number {
  return payableBaseCents(invoice) - invoice.paidAmountCents;
}

/**
 * Obergrenze fuer Gutschriften gegen eine Rechnung: der Rechnungsbetrag (brutto) selbst.
 * Bei einer Schlussrechnung ist `payableCents` (= brutto - Abschlaege) NUR die Zahlungs-
 * grundlage; die Positionen der Schlussrechnung (und damit eine Gutschrift darauf) beziehen
 * sich auf den vollen Bruttobetrag. Verrechnet wird weiterhin nur gegen den offenen Rest.
 */
export function creditCapCents(invoice: Pick<OpenAmountInvoice, "grossTotalCents">): number {
  return invoice.grossTotalCents;
}

/**
 * Tatsaechlich eingegangenes (erstattungsfaehiges) Geld: Verrechnungen mit Gutschriften
 * (method CREDIT_NOTE) und Skonto-Buchungen (method SKONTO / isSkonto) sind kein Geldeingang
 * und werden bei Storno nicht erstattet. Eine Quelle fuer Detailseite, Storno und Vorschau.
 */
export function refundablePaidCents(payments: ReadonlyArray<{ amountCents: number; method: string; isSkonto?: boolean }>): number {
  return Math.max(
    0,
    payments.filter((p) => p.method !== "CREDIT_NOTE" && p.method !== "SKONTO" && !p.isSkonto).reduce((sum, p) => sum + p.amountCents, 0),
  );
}

/** Summe der Gegenbuchungen je Zahlung (positiv), fuer Anzeige und Korrektur-Angebot in der Belegansicht. */
export function reversedCentsByPayment(
  payments: ReadonlyArray<{ kind: string; amountCents: number; reversesPaymentId: string | null }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of payments) {
    if (p.kind === "REVERSAL" && p.reversesPaymentId) map.set(p.reversesPaymentId, (map.get(p.reversesPaymentId) ?? 0) - p.amountCents);
  }
  return map;
}
