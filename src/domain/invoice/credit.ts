/**
 * Teilgutschrift / Teilerstattung: eine festgeschriebene Rechnung wird NICHT
 * komplett storniert, sondern es wird eine Gutschrift über die angegebenen
 * (Teil-)Positionen erzeugt. Das Original bleibt vollständig erhalten und
 * behält seinen Status (für Voll-Storno siehe cancelInvoice).
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";
import { computeLineNet } from "@/lib/pricing/line";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { linkDocuments } from "@/domain/relations";
import { NotFoundError } from "@/domain/errors";
import { creditCapCents, openAmountCents, payableBaseCents } from "@/domain/invoice/amounts";
import { incrementPaidAmount } from "./paid-amount";
import { assertAllowedTaxRates, ratesOfLines } from "@/domain/settings/tax-rates";
import { finalizeWithinTx } from "./finalize";
import { correctionFxOverride } from "@/domain/fx/correction";

export class CreditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditError";
  }
}

export interface PartialCreditLine {
  description: string;
  quantityMilli: number;
  unit?: string;
  unitNetPriceCents: number; // positiv angegeben; intern negiert
  taxRate: number;
  taxCategory: string;
}

export interface PartialCreditInput {
  lines: PartialCreditLine[];
  notes?: string;
  /** Phase 16b: Kurs (Micros) nur fuer Fremdwaehrungs-Altbelege ohne Kurs-Snapshot (siehe cancel.ts). */
  fxOverrideRate?: number;
}

/**
 * Verteilt einen Beleg-Festbetrag (documentDiscountCents/documentChargeCents) proportional
 * zum Verhaeltnis von Teilgutschrift-Positionsnetto zu Original-Positionsnetto (Ruling
 * Fix-Runde 1, Koordinator): `round(amountCents * creditLineTotal / originalLineTotal)`.
 * Ist `originalLineTotal` 0 (z. B. reine 0%-Rechnung), ist das Ergebnis 0 — es gibt keine
 * sinnvolle Bezugsgroesse fuer die Aufteilung. Prozentwerte (…Permille) werden davon NICHT
 * beruehrt und bleiben unveraendert (sie wirken bereits proportional auf die neue Basis).
 */
function proportionalCents(amountCents: number, creditLineTotal: number, originalLineTotal: number): number {
  if (originalLineTotal === 0) return 0;
  return roundHalfUp((amountCents * creditLineTotal) / originalLineTotal);
}

export async function createPartialCreditNote(
  invoiceId: string,
  input: PartialCreditInput,
  opts: { actor?: string; now?: Date; orgId: string },
) {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  if (input.lines.length === 0) throw new CreditError("Mindestens eine Position erforderlich.");

  return dbInternal.$transaction(async (tx) => {
    const original = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true, orgId: true, customerId: true, language: true, number: true, taxScheme: true, currency: true, status: true, type: true, fxRateMicros: true,
        grossTotalCents: true, paidAmountCents: true, payableCents: true,
        sellerSnapshotJson: true, buyerSnapshotJson: true, contactSnapshotJson: true,
        documentDiscountPermille: true, documentDiscountCents: true,
        documentChargePermille: true, documentChargeCents: true, documentChargeReason: true,
        lines: { select: { lineNetCents: true, taxRate: true } },
      },
    });
    if (!original) throw new CreditError("Rechnung nicht gefunden.");
    // Fremde Organisation: wie "nicht gefunden" (404), keine Existenz preisgeben.
    if (original.orgId !== opts.orgId) throw new NotFoundError("Rechnung nicht gefunden.");
    if (original.status === "CANCELLED") throw new CreditError("Rechnung ist storniert.");
    if (original.status === "DRAFT") throw new CreditError("Nur festgeschriebene Rechnungen können (teil-)gutgeschrieben werden.");
    if (original.type === "CREDIT_NOTE") throw new CreditError("Eine Gutschrift kann nicht gutgeschrieben werden.");

    // Phase 12c Fix 1: Saetze der Teilgutschrift-Positionen pruefen, BEVOR irgendetwas
    // geschrieben wird. Die Saetze des Originals gelten als geerbt (GoBD) — eine
    // Gutschrift gegen eine alte, inzwischen aus der Org-Liste entfernte Rechnung (z. B.
    // historisch 16 %) muss weiterhin moeglich sein.
    await assertAllowedTaxRates(tx, original.orgId, ratesOfLines(input.lines), { existing: ratesOfLines(original.lines) });

    // Original-Positionsnetto VOR Beleganpassung (= taxBreakdown.lineTotalCents beim
    // Festschreiben) — Bezugsgroesse fuer die proportionale Aufteilung der Festbetraege.
    const originalLineTotal = original.lines.reduce((s, l) => s + l.lineNetCents, 0);

    const lineNetPosValues = input.lines.map((l) => computeLineNet({ quantityMilli: l.quantityMilli, unitNetPriceCents: Math.abs(l.unitNetPriceCents) }).lineNetCents);
    const creditLineTotal = lineNetPosValues.reduce((s, v) => s + v, 0);
    const creditLines = input.lines.map((l, i) => {
      const unitPos = Math.abs(l.unitNetPriceCents);
      const lineNetPos = lineNetPosValues[i];
      return {
        position: i + 1,
        description: l.description,
        quantityMilli: l.quantityMilli,
        unit: l.unit ?? "C62",
        unitNetPriceCents: -unitPos,
        taxRate: l.taxRate,
        taxCategory: l.taxCategory,
        discountPermille: 0,
        discountCents: 0,
        lineNetCents: -lineNetPos,
      };
    });

    const documentDiscountCents = proportionalCents(original.documentDiscountCents, creditLineTotal, originalLineTotal);
    const documentChargeCents = proportionalCents(original.documentChargeCents, creditLineTotal, originalLineTotal);

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
        notes: `Teilgutschrift zu Rechnung ${original.number}.${input.notes ? " " + input.notes : ""}`,
        correctsInvoiceId: original.id,
        fxOverrideMicros: correctionFxOverride(original, input.fxOverrideRate, (m) => new CreditError(m)),
        // Prozentwerte unveraendert uebernehmen (applyDocumentAdjustments ist vorzeichen-
        // invariant, siehe Ruling Task-1-Review); Festbetraege proportional zum Verhaeltnis
        // Teilgutschrift-/Original-Positionsnetto (Ruling Fix-Runde 1).
        documentDiscountPermille: original.documentDiscountPermille,
        documentDiscountCents,
        documentChargePermille: original.documentChargePermille,
        documentChargeCents,
        documentChargeReason: original.documentChargeReason,
        lines: {
          create: creditLines,
        },
      },
    });

    const finalized = await finalizeWithinTx(tx, credit.id, {
      actor,
      now,
      // Teilgutschrift berichtigt genau die Original-Rechnung: gleicher Empfaenger/Verkaeufer wie dort.
      inheritSnapshotFrom: { sellerSnapshotJson: original.sellerSnapshotJson, buyerSnapshotJson: original.buyerSnapshotJson, contactSnapshotJson: original.contactSnapshotJson },
    });

    // Obergrenze: Σ|bisherige festgeschriebene Gutschriften| + |neue| <= Bemessungsgrundlage
    // des Originals (§ 14c UStG: keine Minderung ohne Grundlage). Bei Verstoss bricht der
    // throw die Transaktion ab -> Nummer und Beleg werden zurueckgerollt.
    const earlier = await tx.invoice.aggregate({
      where: { correctsInvoiceId: original.id, type: "CREDIT_NOTE", status: { notIn: ["DRAFT", "CANCELLED"] }, id: { not: finalized.id } },
      _sum: { grossTotalCents: true },
    });
    const creditedBefore = Math.abs(earlier._sum.grossTotalCents ?? 0);
    const creditGross = Math.abs(finalized.grossTotalCents);
    const base = creditCapCents(original);
    if (creditedBefore + creditGross > base) {
      const remaining = Math.max(0, base - creditedBefore);
      throw new CreditError(
        `Gutschrift übersteigt den gutschreibbaren Rest der Rechnung ${original.number}: verfügbar ${remaining} Cent, beantragt ${creditGross} Cent (bereits gutgeschrieben ${creditedBefore} Cent).`,
      );
    }

    // Verrechnung: der gutgeschriebene Betrag mindert zuerst den offenen Rest der Rechnung
    // (Zahlung "CREDIT_NOTE"); ein darueber hinausgehender Teil ist zu erstatten.
    const openBefore = openAmountCents(original);
    const offsetCents = Math.min(creditGross, Math.max(openBefore, 0));
    if (offsetCents > 0) {
      await tx.payment.create({
        data: {
          invoiceId: original.id,
          amountCents: offsetCents,
          paidAt: now,
          method: "CREDIT_NOTE",
          reference: finalized.number,
          note: `Verrechnung mit Gutschrift ${finalized.number}`,
        },
      });
      const payBase = payableBaseCents(original);
      const newPaid = await incrementPaidAmount(tx, original.id, payBase, offsetCents);
      if (newPaid === null) throw new CreditError(`Die Rechnung ${original.number} wurde parallel geändert (Zahlung/Gutschrift); bitte erneut versuchen.`);
      const newStatus = newPaid >= payBase ? "PAID" : "PARTIALLY_PAID";
      await tx.invoice.update({ where: { id: original.id }, data: { status: newStatus } });
      await appendChangeLog(tx, {
        orgId: original.orgId,
        entity: "INVOICE",
        entityId: original.id,
        action: "PAYMENT",
        actor,
        at: now,
        diff: { creditOffsetCents: offsetCents, creditNote: finalized.number, paidAmountCents: newPaid, status: newStatus },
      });
      // Bewusst KEIN Webhook (payment.recorded/invoice.paid): eine Verrechnung ist keine
      // Kundenzahlung; ein angebundener Shop wuerde sie sonst als Zahlungseingang deuten.
    }
    const refundDueCents = creditGross - offsetCents;

    await linkDocuments(tx, { orgId: original.orgId, fromType: "INVOICE", fromId: finalized.id, toType: "INVOICE", toId: original.id, relationType: "CORRECTS" });

    await appendChangeLog(tx, {
      orgId: original.orgId,
      entity: "INVOICE",
      entityId: original.id,
      action: "UPDATE",
      actor,
      at: now,
      diff: { partialCreditNote: finalized.number, grossTotalCents: finalized.grossTotalCents },
    });
    await logActivity(tx, {
      orgId: original.orgId,
      entityType: "INVOICE",
      entityId: original.id,
      type: "CREDIT_NOTE_CREATED",
      actor,
      at: now,
      data: { creditNote: finalized.number },
    });

    return { originalId: original.id, originalNumber: original.number, creditNote: finalized, offsetCents, refundDueCents };
  });
}
