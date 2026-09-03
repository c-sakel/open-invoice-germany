/**
 * Teilrechnung (§ 13 UStG): eine Rechnung ueber einen Teil einer Gesamtleistung, deren
 * Quelle ein Angebot/eine Auftragsbestaetigung (Quote, kind ANGEBOT/AUFTRAGSBESTAETIGUNG)
 * oder ein Lieferschein sein kann. Zwei grundsaetzlich verschiedene Eingabeformen:
 *
 *   - PERCENT/NET_AMOUNT/GROSS_AMOUNT: der Anteil wird je Steuersatz-Bucket der Quelle
 *     berechnet (`splitByTaxRate`, src/lib/pricing/partial.ts) und als EINE ITEM-Zeile
 *     je Bucket ausgewiesen ("Teilleistung ... zu <Quelle Nr.>").
 *   - POSITIONS/QUANTITIES: einzelne Positionen (voll) bzw. Teilmengen einzelner
 *     Positionen werden 1:1 aus der Quelle kopiert; die bereits abgerechnete Menge wird
 *     gegen `billedQuantities` geprueft (keine Doppelabrechnung).
 *
 * Laeuft komplett in einer Transaktion: Quelle laden+pruefen, Rechnung anlegen
 * (ueber `createDraftInvoiceWithinTx`, das bereits Kunde/Zahlungsmethode/ChangeLog
 * uebernimmt), Kopf-Felder (sourceType/sourceId/partialPermille/sourceLineId je Zeile)
 * nachtragen, Relation PARTIAL_OF setzen, Quelle ggf. auf ACCEPTED heben.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { computeTaxBreakdown } from "@/lib/tax";
import { splitByTaxRate, formatPermilleDE, type TaxRateSplit } from "@/lib/pricing/partial";
import { PricingError } from "@/lib/pricing/errors";
import type { RateBucket } from "@/lib/pricing/allocate";
import { appendChangeLog } from "@/domain/audit";
import { linkDocuments, listRelations } from "@/domain/relations";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { setQuoteStatusWithinTx } from "@/domain/document/status";
import { billedQuantities, type PartialSourceType } from "@/domain/invoice/billed-quantities";
import { NotFoundError } from "@/domain/errors";
import { createPartialInvoiceSchema, type CreatePartialInvoiceInput } from "@/schemas";
import type { CreateInvoiceInput } from "@/schemas";

export class PartialInvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartialInvoiceError";
  }
}

const QUOTE_KINDS_ALLOWED = new Set(["ANGEBOT", "AUFTRAGSBESTAETIGUNG"]);
const QUOTE_STATUS_ALLOWED = new Set(["DRAFT", "SENT", "ACCEPTED"]);
const DELIVERY_NOTE_STATUS_ALLOWED = new Set(["CREATED", "SENT", "DELIVERED"]);

interface PartialSourceLine {
  id: string;
  description: string;
  unit: string;
  quantityMilli: number;
  unitNetPriceCents: number;
  taxRate: number;
  taxCategory: string;
  lineNetCents: number;
}

interface PartialSource {
  customerId: string;
  number: string;
  status: string;
  taxScheme: string;
  currency: string;
  headerText: string | null;
  footerText: string | null;
  paymentTerms: string | null;
  // Fix-Runde 2: Anteilsbasis fuer PERCENT/NET_AMOUNT/GROSS_AMOUNT ist die
  // Gesamtleistung NACH Beleg-Rabatt/-Aufschlag der Quelle (Ruling Koordinator) —
  // ohne diese Felder wuerde eine 100 %-Teilrechnung mehr als grossTotalCents
  // ausweisen, sobald die Quelle einen Beleg-Rabatt/-Aufschlag traegt.
  documentDiscountPermille: number;
  documentDiscountCents: number;
  documentChargePermille: number;
  documentChargeCents: number;
  lines: PartialSourceLine[];
}

/** Laedt und validiert die Quelle (mandantengeprueft) — Quote oder DeliveryNote. */
async function loadPartialSource(
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceType: PartialSourceType,
  sourceId: string,
): Promise<PartialSource> {
  if (sourceType === "QUOTE") {
    const q = await tx.quote.findFirst({ where: { id: sourceId, orgId }, include: { lines: { orderBy: { position: "asc" } } } });
    if (!q) throw new NotFoundError(`Angebot/Auftragsbestaetigung ${sourceId} nicht gefunden.`);
    if (!QUOTE_KINDS_ALLOWED.has(q.kind)) {
      throw new PartialInvoiceError(`Nur ein Angebot/eine Auftragsbestaetigung kann Quelle einer Teilrechnung sein (kind: ${q.kind}).`);
    }
    if (!QUOTE_STATUS_ALLOWED.has(q.status)) {
      throw new PartialInvoiceError(`Angebot/Auftragsbestaetigung im Status "${q.status}" kann nicht teilweise abgerechnet werden.`);
    }
    // Keine Vermischung Teil-/Abschlagsrechnung auf derselben Quelle (Ruling Task-2-Facts).
    const relations = await listRelations(orgId, "QUOTE", sourceId);
    const hasDownpayment = relations.some((r) => r.fromType === "INVOICE" && r.toType === "QUOTE" && r.toId === sourceId && r.relationType === "DOWNPAYMENT_OF");
    if (hasDownpayment) {
      throw new PartialInvoiceError("Auf dieser Quelle bestehen bereits Abschlagsrechnungen — Teil- und Abschlagsrechnungen koennen nicht gemischt werden.");
    }
    return {
      customerId: q.customerId,
      number: q.number ?? "",
      status: q.status,
      taxScheme: q.taxScheme,
      currency: q.currency,
      headerText: q.headerText,
      footerText: q.footerText,
      paymentTerms: q.paymentTerms,
      documentDiscountPermille: q.documentDiscountPermille,
      documentDiscountCents: q.documentDiscountCents,
      documentChargePermille: q.documentChargePermille,
      documentChargeCents: q.documentChargeCents,
      lines: q.lines
        .filter((l) => l.lineType === "ITEM")
        .map((l) => ({
          id: l.id,
          description: l.description,
          unit: l.unit,
          quantityMilli: l.quantityMilli,
          unitNetPriceCents: l.unitNetPriceCents,
          taxRate: l.taxRate,
          taxCategory: l.taxCategory,
          lineNetCents: l.lineNetCents,
        })),
    };
  }

  const n = await tx.deliveryNote.findFirst({ where: { id: sourceId, orgId }, include: { lines: { orderBy: { position: "asc" } } } });
  if (!n) throw new NotFoundError(`Lieferschein ${sourceId} nicht gefunden.`);
  if (!DELIVERY_NOTE_STATUS_ALLOWED.has(n.status)) {
    throw new PartialInvoiceError(`Lieferschein im Status "${n.status}" kann nicht abgerechnet werden.`);
  }
  const lines = n.lines.map((l) => {
    if (l.unitNetPriceCents == null || l.taxRate == null) {
      throw new PartialInvoiceError(`Lieferschein-Position "${l.description}" hat keinen Preis/Steuersatz und kann nicht abgerechnet werden.`);
    }
    // DeliveryNoteLine kennt weder taxCategory noch lineNetCents (Abgrenzung Task 1-Schema)
    // — Standardkategorie "S" (Regelsteuersatz), lineNetCents aus Menge*Preis (kein
    // Positionsrabatt auf Lieferscheinebene vorgesehen).
    return {
      id: l.id,
      description: l.description,
      unit: l.unit,
      quantityMilli: l.quantityMilli,
      unitNetPriceCents: l.unitNetPriceCents,
      taxRate: l.taxRate,
      taxCategory: "S",
      lineNetCents: Math.round((l.quantityMilli * l.unitNetPriceCents) / 1000),
    };
  });
  return {
    customerId: n.customerId,
    number: n.number ?? "",
    status: n.status,
    // DeliveryNote kennt weder taxScheme noch currency (Abgrenzung Task 1-Schema) —
    // Standardwerte wie bei sonstigen Selbstheilungspfaden (createDraftInvoiceWithinTx).
    taxScheme: "REGULAR",
    currency: "EUR",
    headerText: n.headerText,
    footerText: n.footerText,
    paymentTerms: null,
    // DeliveryNote kennt keinen Beleg-Rabatt/-Aufschlag (Abgrenzung Task 1-Schema).
    documentDiscountPermille: 0,
    documentDiscountCents: 0,
    documentChargePermille: 0,
    documentChargeCents: 0,
    lines,
  };
}

interface BuiltLine {
  description: string;
  unit: string;
  quantityMilli: number;
  unitNetPriceCents: number;
  taxRate: number;
  taxCategory: string;
  sourceLineId?: string;
}

function splitLinesForShareMode(
  input: CreatePartialInvoiceInput,
  source: PartialSource,
  existingActiveGrossCents: number,
): { lines: BuiltLine[]; partialPermille: number | null } {
  // Fix-Runde 2 (Ruling Koordinator): Anteilsbasis ist die Gesamtleistung NACH
  // Beleg-Rabatt/-Aufschlag der Quelle, nicht die rohen Positionsbetraege — sonst
  // summiert eine 100 %-Teilrechnung mehr als source.grossTotalCents, sobald die
  // Quelle einen Beleg-Rabatt/-Aufschlag traegt. `computeTaxBreakdown` (wie beim
  // Festschreiben/bei der Konvertierung) liefert je Steuersatz den bereits
  // angepassten Nettobetrag; Σ(net+tax) == source.grossTotalCents (QUOTE) exakt.
  const adjustedTotals = computeTaxBreakdown(
    source.lines.map((l) => ({ lineNetCents: l.lineNetCents, taxRate: l.taxRate, taxCategory: l.taxCategory })),
    {
      discountPermille: source.documentDiscountPermille,
      discountCents: source.documentDiscountCents,
      chargePermille: source.documentChargePermille,
      chargeCents: source.documentChargeCents,
    },
  );
  if (adjustedTotals.breakdown.length === 0) {
    throw new PartialInvoiceError("Die Quelle enthaelt keine abrechenbaren Positionen.");
  }
  const buckets: RateBucket[] = adjustedTotals.breakdown.map((b) => ({
    key: `${b.taxCategory}:${b.taxRate}`,
    taxCategory: b.taxCategory,
    taxRate: b.taxRate,
    netCents: b.netCents,
  }));

  const share = input.mode === "PERCENT" ? { permille: input.permille! } : { amountCents: input.amountCents!, isGross: input.mode === "GROSS_AMOUNT" };
  let splits: TaxRateSplit[];
  try {
    splits = splitByTaxRate(buckets, share);
  } catch (e) {
    if (e instanceof PricingError) throw new PartialInvoiceError(e.message);
    throw e;
  }

  // Fix-Runde 1 (HIGH): kumulativer Ueberbuchungs-Guard fuer PERCENT/NET_AMOUNT/
  // GROSS_AMOUNT — ohne ihn liesse sich dieselbe Quelle beliebig oft ueber 100 % hinaus
  // per Teilrechnung abrechnen (anders als POSITIONS/QUANTITIES, die bereits per
  // `billedQuantities` je Position geschuetzt sind). Zaehlt wie `billingStateFor`s
  // `billedPermille` ALLE aktiven, nicht stornierten Teilrechnungen dieser Quelle
  // (DRAFT zaehlt bereits mit — analog `billedQuantities`). Vergleichsbasis ab
  // Fix-Runde 2: die beleg-angepasste Gesamtleistung (`adjustedTotals.grossTotalCents`),
  // nicht mehr die rohe Bucket-Summe.
  const newGrossCents = splits.reduce((s, sp) => s + sp.grossCents, 0);
  const sourceGrossCents = adjustedTotals.grossTotalCents;
  if (existingActiveGrossCents + newGrossCents > sourceGrossCents) {
    throw new PartialInvoiceError(
      `Die Summe der Teilrechnungen (${existingActiveGrossCents + newGrossCents} Cent) wuerde die Gesamtleistung (${sourceGrossCents} Cent) uebersteigen.`,
    );
  }

  const label =
    input.mode === "PERCENT"
      ? `Teilleistung ${formatPermilleDE(input.permille!)} % zu ${source.number}`
      : `Teilleistung ${formatCents(input.amountCents!)} ${input.mode === "GROSS_AMOUNT" ? "brutto" : "netto"} zu ${source.number}`;

  const lines: BuiltLine[] = splits
    .filter((s) => s.netCents > 0 || s.taxCents > 0)
    .map((s) => ({
      description: label,
      unit: "C62",
      quantityMilli: 1000,
      unitNetPriceCents: s.netCents,
      taxRate: s.taxRate,
      taxCategory: s.taxCategory,
      sourceLineId: undefined,
    }));

  if (lines.length === 0) {
    throw new PartialInvoiceError("Der berechnete Anteil ergibt keine abrechenbare Position (Betrag 0).");
  }

  return { lines, partialPermille: input.mode === "PERCENT" ? input.permille! : null };
}

function positionLinesForMode(
  input: CreatePartialInvoiceInput,
  source: PartialSource,
  billed: Map<string, number>,
): { lines: BuiltLine[]; partialPermille: null } {
  const byId = new Map(source.lines.map((l) => [l.id, l]));
  const lines: BuiltLine[] = [];

  if (input.mode === "POSITIONS") {
    for (const lineId of input.lineIds!) {
      const src = byId.get(lineId);
      if (!src) throw new PartialInvoiceError(`Quellposition ${lineId} unbekannt.`);
      const billedMilli = billed.get(lineId) ?? 0;
      if (billedMilli > 0) {
        throw new PartialInvoiceError(`Position "${src.description}" wurde bereits (teilweise) abgerechnet und kann nicht erneut als volle Position gewaehlt werden.`);
      }
      lines.push({
        description: src.description,
        unit: src.unit,
        quantityMilli: src.quantityMilli,
        unitNetPriceCents: src.unitNetPriceCents,
        taxRate: src.taxRate,
        taxCategory: src.taxCategory,
        sourceLineId: lineId,
      });
    }
  } else {
    for (const q of input.quantities!) {
      const src = byId.get(q.sourceLineId);
      if (!src) throw new PartialInvoiceError(`Quellposition ${q.sourceLineId} unbekannt.`);
      const billedMilli = billed.get(q.sourceLineId) ?? 0;
      const remainingMilli = src.quantityMilli - billedMilli;
      if (q.quantityMilli > remainingMilli) {
        throw new PartialInvoiceError(
          `Menge ${q.quantityMilli} ueberschreitet die Restmenge ${remainingMilli} fuer Position "${src.description}".`,
        );
      }
      lines.push({
        description: src.description,
        unit: src.unit,
        quantityMilli: q.quantityMilli,
        unitNetPriceCents: src.unitNetPriceCents,
        taxRate: src.taxRate,
        taxCategory: src.taxCategory,
        sourceLineId: q.sourceLineId,
      });
    }
  }

  if (lines.length === 0) throw new PartialInvoiceError("Mindestens eine Position ist erforderlich.");
  return { lines, partialPermille: null };
}

/**
 * Bruttosumme aller aktiven (nicht stornierten) Teilrechnungen dieser Quelle — Grundlage
 * des kumulativen Ueberbuchungs-Guards (Fix-Runde 1, HIGH). DRAFT zaehlt bereits mit
 * (analog `billedQuantities`/`billingStateFor`s `billedPermille`).
 */
async function activePartialGrossCents(
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceType: PartialSourceType,
  sourceId: string,
): Promise<number> {
  const active = await tx.invoice.findMany({
    where: { orgId, sourceType, sourceId, type: "PARTIAL", status: { not: "CANCELLED" } },
    select: { grossTotalCents: true },
  });
  return active.reduce((s, i) => s + i.grossTotalCents, 0);
}

export interface CreatePartialInvoiceOptions {
  actor?: string;
  now?: Date;
}

export async function createPartialInvoice(orgId: string, rawInput: unknown, opts: CreatePartialInvoiceOptions = {}) {
  const input = createPartialInvoiceSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  return dbInternal.$transaction(async (tx) => {
    const source = await loadPartialSource(tx, orgId, input.sourceType, input.sourceId);

    const isShareMode = input.mode === "PERCENT" || input.mode === "NET_AMOUNT" || input.mode === "GROSS_AMOUNT";
    const built = isShareMode
      ? splitLinesForShareMode(input, source, await activePartialGrossCents(tx, orgId, input.sourceType, input.sourceId))
      : positionLinesForMode(input, source, await billedQuantities(orgId, input.sourceType, input.sourceId, tx));

    const createInput: CreateInvoiceInput = {
      customerId: source.customerId,
      type: "PARTIAL",
      taxScheme: source.taxScheme as CreateInvoiceInput["taxScheme"],
      currency: source.currency,
      // Leistungszeitpunkt (§14 Abs.4 Nr.6): Quote/DeliveryNote fuehren kein eigenes
      // Lieferdatum-Feld je Teilrechnungs-Anteil — Ersatzweise das Anlagedatum, analog
      // convertDocumentToInvoice (issueDate: now ohne eigenes deliveryDate).
      deliveryDate: now,
      headerText: source.headerText ?? undefined,
      footerText: source.footerText ?? undefined,
      paymentTerms: source.paymentTerms ?? undefined,
      documentDiscountPermille: 0,
      documentDiscountCents: 0,
      documentChargePermille: 0,
      documentChargeCents: 0,
      lines: built.lines.map((l) => ({
        lineType: "ITEM",
        description: l.description,
        quantityMilli: l.quantityMilli,
        unit: l.unit,
        unitNetPriceCents: l.unitNetPriceCents,
        taxRate: l.taxRate as CreateInvoiceInput["lines"][number]["taxRate"],
        taxCategory: l.taxCategory as CreateInvoiceInput["lines"][number]["taxCategory"],
        discountPermille: 0,
        discountCents: 0,
      })),
    };

    const invoice = await createDraftInvoiceWithinTx(tx, orgId, createInput, { actor, now });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { sourceType: input.sourceType, sourceId: input.sourceId, partialPermille: built.partialPermille },
    });

    if (built.lines.some((l) => l.sourceLineId)) {
      for (let i = 0; i < invoice.lines.length; i++) {
        const sourceLineId = built.lines[i]?.sourceLineId;
        if (sourceLineId) {
          await tx.invoiceLine.update({ where: { id: invoice.lines[i].id }, data: { sourceLineId } });
        }
      }
    }

    await linkDocuments(tx, {
      orgId,
      fromType: "INVOICE",
      fromId: invoice.id,
      toType: input.sourceType,
      toId: input.sourceId,
      relationType: "PARTIAL_OF",
    });

    if (input.sourceType === "QUOTE" && (source.status === "DRAFT" || source.status === "SENT")) {
      await setQuoteStatusWithinTx(tx, orgId, input.sourceId, "ACCEPTED", { actor, now });
    }

    await appendChangeLog(tx, {
      orgId,
      entity: "INVOICE",
      entityId: invoice.id,
      action: "PARTIAL_INVOICE_CREATE",
      actor,
      at: now,
      diff: { sourceType: input.sourceType, sourceId: input.sourceId, mode: input.mode },
    });

    return tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { lines: { orderBy: { position: "asc" } } } });
  });
}
