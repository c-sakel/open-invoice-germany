/**
 * Kurs-Snapshot beim Festschreiben (Phase 16b, § 16 Abs. 6 UStG, Art. 230 MwStSystRL).
 *
 * Reihenfolge der Kurswahl:
 *   1. EUR-Beleg: kein Kurs, EUR-Summen = Belegsummen.
 *   2. Korrekturbeleg (Storno/Teilgutschrift, `correctsInvoiceId`): Kurs, Quelle und Kursdatum
 *      des Originals; nur die EUR-Summen werden mit diesem Kurs neu umgerechnet. Traegt das
 *      Original (Altbeleg vor 16b) keinen Kurs, greift die normale Kurswahl (3./4.).
 *   3. Entwurfs-Override `fxOverrideMicros` -> Quelle MANUAL, Kursdatum = Stichtag.
 *   4. Kurstabelle (`rateFor`, Quelle je Organisation).
 *
 * EUR-Steuer: je Steuersatz umgerechnet, `taxTotalEurCents` = Summe der umgerechneten Saetze
 * (BT-111 = diese Summe). Die Umrechnung der Gesamtsteuer in einem Schritt kann davon um
 * hoechstens (Anzahl Saetze - 1) Cent abweichen; massgeblich ist die Summe je Satz, weil die
 * Steuer je Satz geschuldet wird. Wegen symmetrischer Rundung (`toEurCents(-x) = -toEurCents(x)`)
 * hebt ein Vollstorno die EUR-Steuer des Originals exakt auf. Ein Rest-Storno nach Teilgutschrift
 * rundet jede Gutschrift fuer sich: Original + Teilgutschrift(en) + Rest-Storno koennen in EUR je
 * Steuersatz um bis zu 1 Cent je Gutschrift von 0 abweichen (COMPLIANCE.md, offener Punkt).
 *
 * Schlussrechnung (FINAL) in Fremdwaehrung: die volle Steuer (BT-110/BT-111) wird zum Kurs der
 * Schlussrechnung umgerechnet. Die mit Abschlaegen bereits abgerechnete Steuer wird zusaetzlich
 * je Abschlag zu DESSEN eingefrorenem Kurs ermittelt (`deductedTaxEurCents`, Ausweis "davon mit
 * Abschlaegen abgerechnet"); die Differenz beider Kurse ist ein offener Punkt fuer den
 * Steuerberater (COMPLIANCE.md). Abschlag ohne eigenen Kurs (Altbeleg) -> Kurs der Schlussrechnung.
 */
import type { Prisma } from "@/generated/prisma/client";
import { FinalizeError } from "@/domain/invoice/finalize-error";
import { toEurCents } from "./convert";
import { assertSupportedRate } from "./decimal";
import { fxStichtag } from "./pick-rate";
import { rateFor } from "./rate-for";

export type FxSnapshot = {
  fxRateMicros: number | null;
  fxRateDate: Date | null;
  fxRateSource: "BMF_MONTHLY" | "ECB_DAILY" | "MANUAL" | null;
  taxTotalEurCents: number;
  netTotalEurCents: number;
};

export interface FxSnapshotInput {
  orgId: string;
  currency: string;
  fxOverrideMicros: number | null;
  correctsInvoiceId: string | null;
  deliveryDate: Date | null;
  deliveryEnd: Date | null;
  issueDate: Date;
  /** Referenzzeit fuer Vorausrechnung (Stichtag in der Zukunft); Standard: jetzt. */
  now?: Date;
  taxTotalCents: number;
  netTotalCents: number;
  /** Steuer je Satz (Steueraufschluesselung des Belegs) — Grundlage der EUR-Steuersumme. */
  taxBreakdown: ReadonlyArray<{ taxCents: number }>;
}

/** Fehlender oder nicht abbildbarer Kurs: REST antwortet 422 (Duck-Typing `status` in src/api/errors.ts). */
export class FxRateError extends FinalizeError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "FxRateError";
  }
}

const SOURCES = new Set(["BMF_MONTHLY", "ECB_DAILY", "MANUAL"]);
const isSource = (s: string | null): s is "BMF_MONTHLY" | "ECB_DAILY" | "MANUAL" => s !== null && SOURCES.has(s);

function ddmmyyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function convert(input: FxSnapshotInput, rateMicros: number): { taxTotalEurCents: number; netTotalEurCents: number } {
  try {
    assertSupportedRate(rateMicros);
    const taxTotalEurCents = input.taxBreakdown.reduce((sum, b) => sum + toEurCents(b.taxCents, rateMicros), 0);
    return { taxTotalEurCents, netTotalEurCents: toEurCents(input.netTotalCents, rateMicros) };
  } catch (e) {
    if (e instanceof RangeError) throw new FxRateError(`Wechselkurs für ${input.currency}: ${e.message}`);
    throw e;
  }
}

export async function resolveFxSnapshot(tx: Prisma.TransactionClient, input: FxSnapshotInput): Promise<FxSnapshot> {
  if (input.currency === "EUR") {
    return { fxRateMicros: null, fxRateDate: null, fxRateSource: null, taxTotalEurCents: input.taxTotalCents, netTotalEurCents: input.netTotalCents };
  }

  if (input.correctsInvoiceId) {
    const original = await tx.invoice.findFirst({
      where: { id: input.correctsInvoiceId, orgId: input.orgId },
      select: { fxRateMicros: true, fxRateDate: true, fxRateSource: true },
    });
    if (original?.fxRateMicros != null && original.fxRateDate && isSource(original.fxRateSource)) {
      return {
        fxRateMicros: original.fxRateMicros,
        fxRateDate: original.fxRateDate,
        fxRateSource: original.fxRateSource,
        ...convert(input, original.fxRateMicros),
      };
    }
  }

  const stichtag = fxStichtag(input);
  if (input.fxOverrideMicros != null) {
    return { fxRateMicros: input.fxOverrideMicros, fxRateDate: stichtag, fxRateSource: "MANUAL", ...convert(input, input.fxOverrideMicros) };
  }

  const pick = await rateFor(input.orgId, input.currency, stichtag, tx, input.now);
  if (!pick) {
    throw new FxRateError(`Kein Wechselkurs für ${input.currency} zum ${ddmmyyyy(stichtag)} — Kurs manuell eintragen.`);
  }
  return { fxRateMicros: pick.rateMicros, fxRateDate: pick.rateDate, fxRateSource: pick.source, ...convert(input, pick.rateMicros) };
}

/** Steuerzeile eines Abschlags (FinalInvoiceDeduction) mit dem eingefrorenen Kurs des Abschlags (null = EUR/Altbeleg). */
export type DeductionFxEntry = { taxCents: number; fxRateMicros: number | null };

/** Summe der Abschlags-Steuer in EUR, je Abschlag-Steuerzeile zu dessen Kurs; ohne eigenen Kurs gilt `fallbackRateMicros`. */
export function deductedTaxEurCents(entries: ReadonlyArray<DeductionFxEntry>, fallbackRateMicros: number): number {
  return entries.reduce((sum, e) => sum + toEurCents(e.taxCents, e.fxRateMicros ?? fallbackRateMicros), 0);
}

/**
 * Ausweis fuer PDF/API (Task 8): EUR-Steuer, die eine festgeschriebene Schlussrechnung in Fremdwaehrung
 * bereits mit Abschlaegen abgerechnet hat. Liest nur eingefrorene Daten (Abzugs-Snapshot + Kurse der
 * festgeschriebenen Abschlaege), ist also stabil. null, wenn keine Schlussrechnung in Fremdwaehrung.
 */
export async function loadDeductedTaxEurCents(
  db: Prisma.TransactionClient,
  finalInvoiceId: string,
): Promise<number | null> {
  const inv = await db.invoice.findUnique({
    where: { id: finalInvoiceId },
    select: {
      type: true,
      fxRateMicros: true,
      finalDeductions: { select: { taxCents: true, downpaymentInvoice: { select: { fxRateMicros: true } } } },
    },
  });
  if (!inv || inv.type !== "FINAL" || inv.fxRateMicros === null) return null;
  return deductedTaxEurCents(
    inv.finalDeductions.map((d) => ({ taxCents: d.taxCents, fxRateMicros: d.downpaymentInvoice.fxRateMicros })),
    inv.fxRateMicros,
  );
}
