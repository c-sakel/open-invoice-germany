/**
 * Storno einer festgeschriebenen Rechnung.
 *
 * GoBD-konform: Das Original bleibt UNVERÄNDERT erhalten. Es wird eine
 * betragsspiegelbildliche Storno-Gutschrift (type=CREDIT_NOTE) mit eigener
 * Nummer aus dem Kreis angelegt und festgeschrieben; das Original erhält den
 * Status CANCELLED und einen Verweis auf die Gutschrift (§ 31 Abs. 5 UStDV).
 */
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { linkDocuments } from "@/domain/relations";
import { finalizeWithinTx } from "./finalize";

/** Zeilentypen, die keinen Betrag tragen (§8: HEADING/TEXT/SUBTOTAL nie in Summen/XML). */
const NON_ITEM_LINE_TYPES = new Set(["HEADING", "TEXT", "SUBTOTAL"]);

export class CancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelError";
  }
}

export interface CancelOptions {
  actor?: string;
  now?: Date;
}

export async function cancelInvoice(invoiceId: string, opts: CancelOptions = {}) {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  return dbInternal.$transaction(async (tx) => {
    const original = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { orderBy: { position: "asc" } }, finalDeductions: true },
    });
    if (!original) throw new CancelError("Rechnung nicht gefunden.");
    if (original.status === "DRAFT") throw new CancelError("Entwürfe werden gelöscht, nicht storniert.");
    if (original.status === "CANCELLED") throw new CancelError("Rechnung ist bereits storniert.");
    if (original.type === "CREDIT_NOTE") throw new CancelError("Eine Gutschrift/Storno kann nicht erneut storniert werden.");

    // Phase 5: Storno einer Schlussrechnung erstattet nur den tatsaechlich offenen Rest
    // (payableCents), nicht die volle Gesamtleistung — die bereits vereinnahmten Abschlaege
    // (FinalInvoiceDeduction, unveraendert, NICHT kopiert/dupliziert) werden dazu je
    // Steuersatz als positive Ausgleichszeile GEGEN die negierten Gesamtleistungs-Zeilen
    // gebucht, sodass Original + Storno-Gutschrift in Summe = payableCents ergibt (der
    // Kunde hat die Abschlaege bereits bezahlt/erhalten und diese werden hier nicht erneut
    // beruehrt — Ruling Task-2-Brief: "Storno der Schlussrechnung erstattet den Rest").
    const deductionOffsetByRate = new Map<string, { taxRate: number; taxCategory: string; netCents: number }>();
    if (original.type === "FINAL") {
      for (const d of original.finalDeductions) {
        const key = `${d.taxCategory}:${d.taxRate}`;
        const acc = deductionOffsetByRate.get(key) ?? { taxRate: d.taxRate, taxCategory: d.taxCategory, netCents: 0 };
        acc.netCents += d.netCents;
        deductionOffsetByRate.set(key, acc);
      }
    }
    const offsetLines = [...deductionOffsetByRate.values()];

    const negatedLines = original.lines.map((l) => {
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
      };
    });
    const nextPosition = negatedLines.length > 0 ? Math.max(...negatedLines.map((l) => l.position)) + 1 : 1;
    const offsetLinesCreate = offsetLines.map((o, i) => ({
      position: nextPosition + i,
      lineType: "ITEM",
      productId: null,
      description: `Bereits abgerechneter Abschlag (nicht Teil dieser Storno-Gutschrift)`,
      descriptionLong: null,
      articleNumber: null,
      quantityMilli: 1000,
      unit: "C62",
      unitNetPriceCents: o.netCents,
      taxRate: o.taxRate,
      taxCategory: o.taxCategory,
      discountPermille: 0,
      discountCents: 0,
      lineNetCents: o.netCents,
    }));

    const credit = await tx.invoice.create({
      data: {
        orgId: original.orgId,
        customerId: original.customerId,
        type: "CREDIT_NOTE",
        status: "DRAFT",
        taxScheme: original.taxScheme,
        currency: original.currency,
        issueDate: now,
        deliveryDate: original.deliveryDate,
        deliveryStart: original.deliveryStart,
        deliveryEnd: original.deliveryEnd,
        buyerReference: original.buyerReference,
        notes: `Storno zu Rechnung ${original.number}.${original.notes ? " " + original.notes : ""}`,
        paymentTerms: original.paymentTerms,
        correctsInvoiceId: original.id,
        // Phase 5: Verweis auf dieselbe Quelle wie das Original (PARTIAL/DOWNPAYMENT/FINAL) —
        // rein informativ (denormalisierter Schnellzugriff, keine eigene Relation).
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        // Beleg-Rabatt/-Aufschlag unveraendert (positiv) uebernehmen — applyDocumentAdjustments
        // ist vorzeichen-invariant und rechnet bei ausschliesslich negativen Zeilen-Buckets auf
        // den negierten (positiven) Betraegen wie im Original (Ruling Task-1-Review).
        documentDiscountPermille: original.documentDiscountPermille,
        documentDiscountCents: original.documentDiscountCents,
        documentChargePermille: original.documentChargePermille,
        documentChargeCents: original.documentChargeCents,
        documentChargeReason: original.documentChargeReason,
        // Betragsspiegelbild: negierte Beträge, damit Original + Storno = 0 ergibt (bei
        // FINAL-Rechnungen zzgl. der Abschlags-Ausgleichszeilen oben, damit die Gutschrift
        // in Summe payableCents statt grossTotalCents erstattet). Zeilentyp/Langtext/
        // Artikelnummer 1:1 uebernehmen (§8: die Struktur der Rechnung bleibt im Storno
        // erkennbar). Nicht-ITEM-Zeilen tragen weiterhin keine Betraege.
        lines: {
          create: [...negatedLines, ...offsetLinesCreate],
        },
      },
    });

    const finalizedCredit = await finalizeWithinTx(tx, credit.id, {
      actor,
      now,
      // Storno berichtigt genau das Original: gleicher Empfaenger/Verkaeufer wie dort.
      inheritSnapshotFrom: { sellerSnapshotJson: original.sellerSnapshotJson, buyerSnapshotJson: original.buyerSnapshotJson },
    });

    await tx.invoice.update({
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
      diff: { status: "CANCELLED", reversedBy: finalizedCredit.number },
    });

    return { originalId: original.id, originalNumber: original.number, creditNote: finalizedCredit };
  });
}
