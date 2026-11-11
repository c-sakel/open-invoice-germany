/**
 * Lädt eine Rechnung samt Org/Kunde/Positionen und baut die E-Rechnungs-Daten.
 * Bei Gutschrift/Korrektur wird die Vorgänger-Referenz (BG-3) mit aufgelöst.
 * Phase 5: bei type FINAL zusätzlich der Abzugs-Snapshot (FinalInvoiceDeduction, je
 * Abschlagsrechnung über alle Steuersätze aggregiert); bei PARTIAL/DOWNPAYMENT/FINAL
 * zusätzlich die Nummer/Art der Quelle (Angebot/Auftragsbestätigung/Lieferschein) — NUR
 * fürs PDF ("Bezug zu ..."), nie ins XML.
 */
import { dbInternal } from "@/lib/db";
import { openAmountCents } from "@/domain/invoice/amounts";
import { docStrings, resolveDocLanguage } from "@/lib/i18n/doc";
import { toEurCents } from "@/domain/fx/convert";
import { fxStichtag } from "@/domain/fx/pick-rate";
import { rateFor } from "@/domain/fx/rate-for";
import { taxBreakdownSchema } from "@/schemas";
import { buildEInvoiceData, type MapInput } from "./mapper";

const INCLUDE = {
  lines: { orderBy: { position: "asc" as const } },
  org: true,
  customer: true,
  finalDeductions: { orderBy: { issueDate: "asc" as const } },
} as const;

/** Entwurf in Fremdwaehrung: Kurs live per rateFor (Vorschau, nicht festgeschrieben). Kein Kurs
 * oder nicht abbildbar -> kein EUR-Block (die Vorschau darf nicht scheitern). */
async function previewFx(invoice: {
  orgId: string;
  currency: string;
  fxOverrideMicros: number | null;
  deliveryDate: Date | null;
  deliveryEnd: Date | null;
  issueDate: Date;
  netTotalCents: number;
  taxBreakdownJson: string;
}): Promise<Pick<MapInput, "fxRateMicros" | "fxRateDate" | "fxRateSource" | "taxTotalEurCents" | "netTotalEurCents">> {
  const none = { fxRateMicros: null, fxRateDate: null, fxRateSource: null, taxTotalEurCents: null, netTotalEurCents: null };
  if (invoice.currency === "EUR") return none;
  const stichtag = fxStichtag(invoice);
  const pick =
    invoice.fxOverrideMicros != null
      ? { rateMicros: invoice.fxOverrideMicros, rateDate: stichtag, source: "MANUAL" as const }
      : await rateFor(invoice.orgId, invoice.currency, stichtag);
  if (!pick) return none;
  let rawBreakdown: unknown;
  try {
    rawBreakdown = JSON.parse(invoice.taxBreakdownJson);
  } catch {
    return none;
  }
  const breakdown = taxBreakdownSchema.safeParse(rawBreakdown);
  if (!breakdown.success) return none;
  try {
    return {
      fxRateMicros: pick.rateMicros,
      fxRateDate: pick.rateDate,
      fxRateSource: pick.source,
      taxTotalEurCents: breakdown.data.reduce((sum, b) => sum + toEurCents(b.taxCents, pick.rateMicros), 0),
      netTotalEurCents: toEurCents(invoice.netTotalCents, pick.rateMicros),
    };
  } catch (e) {
    if (e instanceof RangeError) return none;
    throw e;
  }
}

/** Aggregiert die (ggf. je Steuersatz mehrfachen) Abzugs-Snapshot-Zeilen einer
 * Abschlagsrechnung zu EINEM Eintrag über alle Steuersätze (netCents/taxCents/grossCents
 * summiert) — Reihenfolge/Werte für BG-3, BT-22-Aufstellung und PDF-Abzugsblock. */
function aggregateDeductions(
  rows: { downpaymentInvoiceId: string; number: string; issueDate: Date; netCents: number; taxCents: number; grossCents: number }[],
): { number: string; issueDate: Date; netCents: number; taxCents: number; grossCents: number }[] {
  const byDownpayment = new Map<string, { number: string; issueDate: Date; netCents: number; taxCents: number; grossCents: number }>();
  for (const row of rows) {
    const existing = byDownpayment.get(row.downpaymentInvoiceId);
    if (existing) {
      existing.netCents += row.netCents;
      existing.taxCents += row.taxCents;
      existing.grossCents += row.grossCents;
    } else {
      byDownpayment.set(row.downpaymentInvoiceId, {
        number: row.number,
        issueDate: row.issueDate,
        netCents: row.netCents,
        taxCents: row.taxCents,
        grossCents: row.grossCents,
      });
    }
  }
  return [...byDownpayment.values()].sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime() || a.number.localeCompare(b.number));
}

export async function loadEInvoiceData(invoiceId: string) {
  const invoice = await dbInternal.invoice.findUnique({ where: { id: invoiceId }, include: INCLUDE });
  if (!invoice) return null;

  const lang = resolveDocLanguage(invoice.language);
  const sourceLabels = docStrings(lang).sourceLabels;
  let sourceNumber: string | null = null;
  let sourceLabel: string | null = null;
  if (invoice.sourceType === "QUOTE" && invoice.sourceId) {
    const quote = await dbInternal.quote.findUnique({ where: { id: invoice.sourceId }, select: { number: true, kind: true } });
    if (quote) {
      sourceNumber = quote.number;
      sourceLabel = (sourceLabels as Record<string, string>)[quote.kind] ?? sourceLabels.ANGEBOT;
    }
  } else if (invoice.sourceType === "DELIVERY_NOTE" && invoice.sourceId) {
    const deliveryNote = await dbInternal.deliveryNote.findUnique({ where: { id: invoice.sourceId }, select: { number: true } });
    if (deliveryNote) {
      sourceNumber = deliveryNote.number;
      sourceLabel = sourceLabels.DELIVERY_NOTE;
    }
  }

  // BT-113 nennt nur echte Zahlungen: Verrechnungen mit Teilgutschriften (method CREDIT_NOTE)
  // stehen schon als eigene Gutschriftsbelege und duerfen den Zahlbetrag des Originals nicht senken.
  const offsets = await dbInternal.payment.aggregate({
    where: { invoiceId: invoice.id, method: "CREDIT_NOTE" },
    _sum: { amountCents: true },
  });
  // Nur Entwuerfe rechnen live; festgeschriebene Belege tragen den eingefrorenen Snapshot.
  const draftFx = invoice.status === "DRAFT" && invoice.fxRateMicros == null ? await previewFx(invoice) : null;
  const data = buildEInvoiceData({
    ...invoice,
    ...draftFx,
    paidAmountCents: invoice.paidAmountCents - (offsets._sum.amountCents ?? 0),
    deductions: invoice.type === "FINAL" ? aggregateDeductions(invoice.finalDeductions) : undefined,
    sourceNumber,
    sourceLabel,
  });
  // Phase 7 (§37) — offener Betrag zum Renderzeitpunkt fürs GiroCode-Layout (Ruling:
  // openAmountCents(invoice) = payableBaseCents(invoice) - paidAmountCents, NICHT das
  // XML-BT-115 payableCents). Fix-Runde 1 (Koordinator): bestehende Domain-Funktion
  // wiederverwenden statt sie hier erneut abzuleiten.
  data.giroAmountCents = openAmountCents(invoice);
  if (draftFx && data.fx) data.fx.preview = true;

  if (invoice.correctsInvoiceId) {
    const original = await dbInternal.invoice.findUnique({
      where: { id: invoice.correctsInvoiceId },
      select: { number: true, issueDate: true, reversedByInvoiceId: true },
    });
    if (original) {
      data.precedingInvoiceNumber = original.number;
      data.precedingInvoiceDate = original.issueDate;
      // Phase 12b: ein CREDIT_NOTE entsteht auf zwei Wegen (cancel.ts = Vollstorno,
      // credit.ts = Teilgutschrift) — beide setzen correctsInvoiceId. Unterscheidbar
      // allein ueber den Rueckverweis: nur der Vollstorno setzt
      // Invoice.reversedByInvoiceId (cancel.ts:229).
      if (invoice.type === "CREDIT_NOTE") {
        data.creditNoteKind = original.reversedByInvoiceId === invoice.id ? "STORNO" : "KORREKTUR";
      }
    }
  }

  return { invoice, data };
}
