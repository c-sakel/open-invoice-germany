/**
 * Storno einer festgeschriebenen Rechnung.
 *
 * GoBD-konform: Das Original bleibt UNVERÄNDERT erhalten. Es wird eine
 * betragsspiegelbildliche Storno-Gutschrift (type=CREDIT_NOTE) mit eigener
 * Nummer aus dem Kreis angelegt und festgeschrieben; das Original erhält den
 * Status CANCELLED und einen Verweis auf die Gutschrift (§ 31 Abs. 5 UStDV).
 */
import { lockRow } from "@/lib/db-lock";
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";
import type { TaxBreakdownEntry } from "@/lib/tax";
import { reconcileNetsForGross } from "@/lib/pricing/partial";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { linkDocuments } from "@/domain/relations";
import { emitEvent } from "@/domain/webhook/emit";
import { serializeInvoice } from "@/api/serializers/invoice";
import { NotFoundError } from "@/domain/errors";
import { finalizeWithinTx } from "./finalize";
import { correctionFxOverride } from "@/domain/fx/correction";
import { refundablePaidCents } from "./amounts";

/** Zeilentypen, die keinen Betrag tragen (§8: HEADING/TEXT/SUBTOTAL nie in Summen/XML). */
const NON_ITEM_LINE_TYPES = new Set(["HEADING", "TEXT", "SUBTOTAL"]);

interface StornoCreateLine {
  position: number;
  lineType: string;
  productId: string | null;
  description: string;
  descriptionLong: string | null;
  articleNumber: string | null;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number;
  taxRate: number;
  taxCategory: string;
  discountPermille: number;
  discountCents: number;
  lineNetCents: number;
  ossCategory?: string | null;
}

/**
 * Storno-Zeilen fuer eine normale (nicht FINAL) Rechnung: betragsspiegelbildliches
 * 1:1-Abbild aller Original-Zeilen (Zeilentyp/Langtext/Artikelnummer erhalten, damit die
 * Struktur der Rechnung im Storno erkennbar bleibt — §8).
 */
function mirrorLines(original: { lines: readonly { position: number; lineType: string; productId: string | null; description: string; descriptionLong: string | null; articleNumber: string | null; quantityMilli: number; unit: string; unitNetPriceCents: number; taxRate: number; taxCategory: string; discountPermille: number; discountCents: number; lineNetCents: number; ossCategory: string | null }[] }): StornoCreateLine[] {
  return original.lines.map((l) => {
    const isItem = !NON_ITEM_LINE_TYPES.has(l.lineType);
    return {
      position: l.position,
      lineType: l.lineType,
      productId: l.productId,
      description: l.description,
      descriptionLong: l.descriptionLong,
      articleNumber: l.articleNumber,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: isItem ? -l.unitNetPriceCents : 0,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
      lineNetCents: isItem ? -l.lineNetCents : 0,
      // Phase 16e: Kategorie-Snapshot des Originals (Storno zieht in derselben Kategorie ab).
      ossCategory: l.ossCategory,
    };
  });
}

/**
 * Storno-Zeilen als Summenzeilen (Fix-Runde 1, MEDIUM — Ruling Koordinator): GENAU EINE
 * Zeile je Steuersatz/-kategorie, nicht die gespiegelten Gesamtleistungs-Zeilen zzgl.
 * Ausgleichszeilen (das fuehrte bei einem Beleg-Rabatt/-Aufschlag mit mehreren Steuersaetzen
 * zu gemischten Vorzeichen je Bucket und liess `applyDocumentAdjustments` mit einem
 * PricingError abbrechen). Verwendet fuer
 *   - FINAL-Rechnungen (Restbetrag nach Abzug der Abschlaege) und
 *   - Rechnungen mit festgeschriebenen Teilgutschriften (Rest-Storno, nur der noch nicht
 *     gutgeschriebene Teil wird erstattet).
 * Je Satz:
 *   net = -(rateNetAfterAdjustments - deductedNetForRate - creditedNetForRate)
 * `rateNetAfterAdjustments` kommt direkt aus dem beim Festschreiben gespeicherten
 * `taxBreakdownJson` (bereits NACH Beleg-Rabatt/-Aufschlag), `deductedNetForRate` aus den
 * `FinalInvoiceDeduction`-Zeilen, `creditedNetForRate` aus den `taxBreakdownJson` der
 * festgeschriebenen Teilgutschriften (Betraege positiv gerechnet). Die Summe ueber alle
 * Zeilen ergibt exakt `-targetGrossCents`; das Storno-Dokument selbst traegt
 * documentDiscount/Charge = 0, weil die Beleganpassung bereits in den Bucket-Betraegen steckt.
 */
function summaryStornoLines(input: {
  taxBreakdownJson: string;
  targetGrossCents: number;
  description: string;
  finalDeductions: readonly { taxRate: number; taxCategory: string; netCents: number; taxCents: number }[];
  credits: readonly { taxBreakdownJson: string }[];
}): StornoCreateLine[] {
  const breakdown = JSON.parse(input.taxBreakdownJson) as TaxBreakdownEntry[];

  const deductedByRate = new Map<string, { netCents: number; taxCents: number }>();
  for (const d of input.finalDeductions) {
    const key = `${d.taxCategory}:${d.taxRate}`;
    const acc = deductedByRate.get(key) ?? { netCents: 0, taxCents: 0 };
    acc.netCents += d.netCents;
    acc.taxCents += d.taxCents;
    deductedByRate.set(key, acc);
  }

  // Bereits gutgeschriebene Nettobetraege je Bucket (Gutschrift-Breakdowns tragen negative
  // Betraege -> Betrag positiv rechnen).
  const creditedNetByRate = new Map<string, number>();
  for (const credit of input.credits) {
    for (const e of JSON.parse(credit.taxBreakdownJson) as TaxBreakdownEntry[]) {
      const key = `${e.taxCategory}:${e.taxRate}`;
      creditedNetByRate.set(key, (creditedNetByRate.get(key) ?? 0) + Math.abs(e.netCents));
    }
  }
  const originalKeys = new Set(breakdown.map((e) => `${e.taxCategory}:${e.taxRate}`));
  for (const key of creditedNetByRate.keys()) {
    if (!originalKeys.has(key)) {
      throw new CancelError("Eine Teilgutschrift enthält einen Steuersatz, der in der Rechnung nicht vorkommt — der Restbetrag kann nicht ermittelt werden.");
    }
  }

  // B6 (Fix-Welle): `entry.netCents - deducted.netCents` allein garantiert NICHT, dass
  // die Summe der Storno-Zeilen nach der erneuten Steuerberechnung beim Festschreiben
  // des Stornos (`finalizeWithinTx` -> `computeTaxBreakdown`) exakt dem Zielbetrag
  // entspricht — zwei unabhaengig gerundete Steuerbetraege muessen sich nicht zur selben
  // Rundung addieren. `reconcileNetsForGross` (src/lib/pricing/partial.ts) verschiebt bei
  // Bedarf EIN Steuersatz-Bucket um ±1 Cent Netto, damit die Summe wieder exakt trifft. Bei
  // GENAU EINEM Steuersatz ist das rechnerisch nicht immer moeglich — die kleinstmoegliche
  // Abweichung (i. d. R. ±1 Cent) bleibt dann bestehen (dokumentierte Ausnahme,
  // docs/LIMITATIONEN.md, ARCHITEKTUR.md).
  const naiveNets = breakdown.map((entry) => {
    const key = `${entry.taxCategory}:${entry.taxRate}`;
    const deducted = deductedByRate.get(key) ?? { netCents: 0, taxCents: 0 };
    return entry.netCents - deducted.netCents - (creditedNetByRate.get(key) ?? 0);
  });
  if (input.credits.length > 0 && naiveNets.some((n) => n < 0)) {
    throw new CancelError("Die Teilgutschriften übersteigen den Rechnungsbetrag in mindestens einem Steuersatz — der Restbetrag kann nicht ermittelt werden.");
  }
  const rateBuckets = breakdown.map((entry, i) => ({ netCents: naiveNets[i], taxRate: entry.taxRate }));
  const reconciledNets = reconcileNetsForGross(rateBuckets, input.targetGrossCents);
  // Ist der Zielbetrag mit ganzzahligem Netto nicht erreichbar (ein Steuersatz: die Funktion
  // net + round(net * satz) ueberspringt einzelne Bruttowerte), darf der Storno den Rest NIE
  // ueber-erstatten: dann das Netto schrittweise senken, bis die Summe <= Ziel ist (Abweichung
  // hoechstens wenige Cent zugunsten der Rechnung; BR-CO-17 verbietet einen "krummen" Steuerbetrag).
  const grossOf = (nets: readonly number[]) => nets.reduce((sum, n, i) => sum + n + roundHalfUp((n * breakdown[i].taxRate) / 100), 0);
  for (let guard = 0; guard < 20 && grossOf(reconciledNets) > input.targetGrossCents; guard++) {
    const idx = reconciledNets.findIndex((n) => n > 0);
    if (idx < 0) break;
    reconciledNets[idx] -= 1;
  }

  const lines = breakdown.map((entry, i) => ({ entry, remainingNetCents: reconciledNets[i] }));
  // Rest-Storno: vollstaendig gutgeschriebene Saetze entfallen (keine 0-Zeilen im Beleg).
  const kept = input.credits.length > 0 ? lines.filter((l) => l.remainingNetCents !== 0) : lines;

  return kept.map(({ entry, remainingNetCents }, i) => ({
    position: i + 1,
    lineType: "ITEM",
    productId: null,
    description: input.description,
    descriptionLong: null,
    articleNumber: null,
    quantityMilli: 1000,
    unit: "C62",
    unitNetPriceCents: -remainingNetCents,
    taxRate: entry.taxRate,
    taxCategory: entry.taxCategory,
    discountPermille: 0,
    discountCents: 0,
    lineNetCents: -remainingNetCents,
  }));
}

export class CancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelError";
  }
}

export interface CancelOptions {
  actor?: string;
  now?: Date;
  /** Pflicht: die Rechnung muss zu dieser Organisation gehoeren (sonst NotFoundError). */
  orgId: string;
  /** Optionaler Stornogrund — landet in den Notizen des Stornobelegs und im ChangeLog-Diff. */
  reason?: string;
  /**
   * Phase 16b: Kurs (Micros) fuer den Storno eines Fremdwaehrungs-Altbelegs OHNE Kurs-Snapshot.
   * Reihenfolge beim Festschreiben: Kurs des Originals > dieser Override > Kurstabelle.
   * Traegt das Original einen Kurs, wird der Override nicht gespeichert (Originalkurs gilt).
   */
  fxOverrideRate?: number;
}

export async function cancelInvoice(invoiceId: string, opts: CancelOptions) {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  return dbInternal.$transaction(async (tx) => {
    // Zeilensperre (17b): Doppel-Storno unter Postgres ausgeschlossen (SQLite: No-op).
    await lockRow(tx, "Invoice", invoiceId, opts.orgId);
    const original = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { orderBy: { position: "asc" } }, finalDeductions: true },
    });
    if (!original) throw new CancelError("Rechnung nicht gefunden.");
    // Org-Scope (B2): fremde Belege sind "nicht gefunden" (Muster payment.ts).
    if (original.orgId !== opts.orgId) throw new NotFoundError("Rechnung nicht gefunden.");
    if (original.status === "DRAFT") throw new CancelError("Entwürfe werden gelöscht, nicht storniert.");
    if (original.status === "CANCELLED") throw new CancelError("Rechnung ist bereits storniert.");
    if (original.type === "CREDIT_NOTE") throw new CancelError("Eine Gutschrift/Storno kann nicht erneut storniert werden.");
    const fxOverrideMicros = correctionFxOverride(original, opts.fxOverrideRate, (m) => new CancelError(m));

    // B7: Abschlagsrechnung, die in einer nicht stornierten Schlussrechnung verrechnet ist,
    // darf nicht storniert werden (die Schlussrechnung zoege sonst einen stornierten Abschlag ab).
    if (original.type === "DOWNPAYMENT") {
      const deduction = await tx.finalInvoiceDeduction.findFirst({
        where: { downpaymentInvoiceId: original.id, finalInvoice: { status: { not: "CANCELLED" } } },
        select: { finalInvoice: { select: { id: true, number: true, grossTotalCents: true, payableCents: true } } },
      });
      // Eine vollstaendig gutgeschriebene Schlussrechnung ist wirtschaftlich aufgehoben und
      // nicht mehr stornierbar -> ihre Abschlaege duerfen nicht dauerhaft gesperrt bleiben.
      let finalFullyCredited = false;
      if (deduction) {
        const fc = await tx.invoice.aggregate({
          where: { correctsInvoiceId: deduction.finalInvoice.id, type: "CREDIT_NOTE", status: { notIn: ["DRAFT", "CANCELLED"] } },
          _sum: { grossTotalCents: true },
        });
        finalFullyCredited = Math.abs(fc._sum.grossTotalCents ?? 0) >= (deduction.finalInvoice.payableCents ?? deduction.finalInvoice.grossTotalCents);
      }
      if (deduction && !finalFullyCredited) {
        throw new CancelError(`Abschlag ist in Schlussrechnung ${deduction.finalInvoice.number ?? "(ohne Nummer)"} verrechnet — zuerst die Schlussrechnung stornieren.`);
      }
    }

    // B6: bereits festgeschriebene Teilgutschriften -> Rest-Storno (nur der noch nicht
    // gutgeschriebene Betrag wird erstattet, Summe aller Gutschriften = Originalbetrag).
    const partialCredits = await tx.invoice.findMany({
      where: { correctsInvoiceId: original.id, type: "CREDIT_NOTE", status: { not: "DRAFT" } },
      select: { number: true, grossTotalCents: true, taxBreakdownJson: true },
      orderBy: { createdAt: "asc" },
    });

    // Phase 5 (Fix-Runde 1, MEDIUM — Ruling Koordinator): Storno einer Schlussrechnung
    // erstattet nur den tatsaechlich offenen Rest (payableCents), nicht die volle
    // Gesamtleistung — als GENAU EINE Summenzeile je Steuersatz (summaryStornoLines), NICHT
    // als gespiegelte Gesamtleistungs-Zeilen zzgl. separater Ausgleichszeilen. Gleiches gilt
    // fuer den Rest-Storno nach Teilgutschriften. documentDiscount/Charge = 0 auf dem
    // Storno-Dokument, weil die Beleganpassung bereits im taxBreakdownJson eingepreist ist.
    const isFinalStorno = original.type === "FINAL";
    const isRestStorno = partialCredits.length > 0;
    const summaryMode = isFinalStorno || isRestStorno;

    let stornoLines: StornoCreateLine[];
    if (summaryMode) {
      const creditedGrossCents = partialCredits.reduce((sum, c) => sum + Math.abs(c.grossTotalCents), 0);
      const targetGrossCents = (isFinalStorno ? (original.payableCents ?? 0) : original.grossTotalCents) - creditedGrossCents;
      if (isRestStorno && targetGrossCents <= 0) throw new CancelError("Rechnung ist bereits vollständig gutgeschrieben.");
      stornoLines = summaryStornoLines({
        taxBreakdownJson: original.taxBreakdownJson,
        targetGrossCents,
        description: isFinalStorno
          ? `Storno Schlussrechnung ${original.number} – Restbetrag nach Abzug der Abschlagsrechnungen${isRestStorno ? " und Teilgutschriften" : ""}`
          : `Storno Rechnung ${original.number} – Restbetrag nach Teilgutschrift`,
        finalDeductions: isFinalStorno ? original.finalDeductions : [],
        credits: partialCredits,
      });
    } else {
      stornoLines = mirrorLines(original);
    }

    const reason = opts.reason?.trim() || undefined;
    const creditRef = isRestStorno ? ` (Restbetrag nach Teilgutschrift ${partialCredits.map((c) => c.number).join(", ")})` : "";

    const credit = await tx.invoice.create({
      data: {
        orgId: original.orgId,
        customerId: original.customerId,
        language: original.language,
        type: "CREDIT_NOTE",
        status: "DRAFT",
        taxScheme: original.taxScheme,
        currency: original.currency,
        issueDate: now,
        deliveryDate: original.deliveryDate,
        deliveryStart: original.deliveryStart,
        deliveryEnd: original.deliveryEnd,
        buyerReference: original.buyerReference,
        notes: `Storno zu Rechnung ${original.number}${creditRef}.${reason ? ` Grund: ${reason}` : ""}${original.notes ? " " + original.notes : ""}`,
        // B8: ein Storno traegt keine Zahlungsbedingungen des Originals.
        paymentTerms: null,
        correctsInvoiceId: original.id,
        fxOverrideMicros,
        // Phase 5: Verweis auf dieselbe Quelle wie das Original (PARTIAL/DOWNPAYMENT/FINAL) —
        // rein informativ (denormalisierter Schnellzugriff, keine eigene Relation).
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        // Beleg-Rabatt/-Aufschlag: bei FINAL-Storno bewusst 0 (bereits in finalStornoLines
        // eingepreist, siehe dort); sonst unveraendert (positiv) uebernommen —
        // applyDocumentAdjustments ist vorzeichen-invariant und rechnet bei ausschliesslich
        // negativen Zeilen-Buckets auf den negierten (positiven) Betraegen wie im Original
        // (Ruling Task-1-Review).
        documentDiscountPermille: summaryMode ? 0 : original.documentDiscountPermille,
        documentDiscountCents: summaryMode ? 0 : original.documentDiscountCents,
        documentChargePermille: summaryMode ? 0 : original.documentChargePermille,
        documentChargeCents: summaryMode ? 0 : original.documentChargeCents,
        documentChargeReason: summaryMode ? null : original.documentChargeReason,
        // Betragsspiegelbild: negierte Betraege, damit Original + Storno = 0 ergibt
        // (bei FINAL: Summe = -payableCents, siehe finalStornoLines). Zeilentyp/Langtext/
        // Artikelnummer bei einer normalen Rechnung 1:1 uebernommen (§8: die Struktur bleibt
        // im Storno erkennbar); bei FINAL eine Summenzeile je Steuersatz (siehe oben).
        lines: {
          create: stornoLines,
        },
      },
    });

    const finalizedCredit = await finalizeWithinTx(tx, credit.id, {
      actor,
      now,
      // Storno berichtigt genau das Original: gleicher Empfaenger/Verkaeufer wie dort.
      inheritSnapshotFrom: { sellerSnapshotJson: original.sellerSnapshotJson, buyerSnapshotJson: original.buyerSnapshotJson, contactSnapshotJson: original.contactSnapshotJson },
    });

    const cancelledOriginal = await tx.invoice.update({
      where: { id: original.id },
      data: { status: "CANCELLED", reversedByInvoiceId: finalizedCredit.id },
    });

    await linkDocuments(tx, { orgId: original.orgId, fromType: "INVOICE", fromId: finalizedCredit.id, toType: "INVOICE", toId: original.id, relationType: "REVERSES" });
    await linkDocuments(tx, { orgId: original.orgId, fromType: "INVOICE", fromId: finalizedCredit.id, toType: "INVOICE", toId: original.id, relationType: "CORRECTS" });

    await appendChangeLog(tx, {
      orgId: original.orgId,
      entity: "INVOICE",
      entityId: original.id,
      action: "CANCEL",
      actor,
      at: now,
      diff: { status: "CANCELLED", reversedBy: finalizedCredit.number, ...(reason ? { reason } : {}) },
    });
    await logActivity(tx, {
      orgId: original.orgId,
      entityType: "INVOICE",
      entityId: original.id,
      type: "CANCELLED",
      actor,
      at: now,
      data: { reversedBy: finalizedCredit.number, ...(reason ? { reason } : {}) },
    });

    // Webhook-Outbox (Phase 10, Task 5): "invoice.cancelled" bezieht sich auf das
    // Original (jetzt Status CANCELLED) — die Storno-Gutschrift selbst hat bereits ihr
    // eigenes "invoice.finalized" ausgeloest (finalizeWithinTx oben).
    await emitEvent(tx, {
      orgId: original.orgId,
      type: "invoice.cancelled",
      objectName: "Invoice",
      objectId: original.id,
      data: serializeInvoice({ ...cancelledOriginal, lines: original.lines }, new Set()),
      now,
    });

    // Erstattung: tatsaechlich eingegangenes Geld (ohne Verrechnungen mit Gutschriften und Skonto-Buchungen).
    const payments = await tx.payment.findMany({
      where: { invoiceId: original.id },
      select: { amountCents: true, method: true, isSkonto: true },
    });
    const refundDueCents = refundablePaidCents(payments);

    return { originalId: original.id, originalNumber: original.number, creditNote: finalizedCredit, refundDueCents };
  });
}
