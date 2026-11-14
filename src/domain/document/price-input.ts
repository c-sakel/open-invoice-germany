/**
 * Preis-Eingabe der API (Phase 18f, Task 6): Sub-Cent- und Bruttopreise in REST und MCP.
 *
 * `resolvePriceInput` laeuft VOR dem bestehenden Zod-Schema und der Domainfunktion und bringt jede
 * Positionszeile in die Netto-Form (`unitNetPriceCents` + optional `unitNetPriceMilliCents`).
 * Bruttopreise (`unitGrossPriceCents` / `lineGrossCents`) werden je Steuersatz nach
 * EN 16931 BR-CO-17 umgerechnet (`resolveGrossLines`); eine verbleibende Abweichung (max. 1 Cent
 * je Steuersatz) wird als `grossDeviationCents` ausgewiesen (Ruling 2026-11-13: kein BT-114).
 * Ohne `lines` (Teil-Update) und fuer reine Nettozeilen bleibt der Body unveraendert.
 */
import { z } from "zod";
import { MAX_UNIT_PRICE_MILLI_CENTS, formatCents, milliCentsToCents, normalizeMilli } from "@/lib/money";
import { resolveGrossLines } from "@/lib/pricing/gross";
import { defaultCategoryForScheme } from "@/lib/tax";
import {
  TaxCategory,
  TaxScheme,
  documentObjectSchema,
  atomicPaymentSchema,
  invoiceHeaderFields,
  invoiceLineBaseShape,
} from "@/schemas";

/** Preisfelder einer API-Zeile (Netto in Cent/Milli-Cent oder Brutto je Einheit/Zeile). */
export const apiLinePriceFields = {
  unitNetPriceCents: z.number().int().optional().describe("Nettoeinzelpreis in Cent"),
  unitNetPriceMilliCents: z
    .number()
    .int()
    .min(0)
    .max(MAX_UNIT_PRICE_MILLI_CENTS)
    .nullable()
    .optional()
    .describe("Nettoeinzelpreis in tausendstel Cent (0,002 EUR = 200); fuehrend, unitNetPriceCents ist dessen Rundung"),
  unitGrossPriceCents: z.number().int().min(0).optional().describe("Bruttoeinzelpreis in Cent; wird je Steuersatz in Netto umgerechnet (nicht mit Rabatten)"),
  lineGrossCents: z.number().int().min(0).optional().describe("Bruttozeilenbetrag in Cent; hat Vorrang vor Menge x Bruttoeinzelpreis (nicht mit Rabatten)"),
};

const apiLineDocSchema = z.object({
  ...invoiceLineBaseShape,
  taxCategory: TaxCategory.optional(),
  ...apiLinePriceFields,
});

const finalizeDocFields = {
  finalize: z.boolean().default(false),
  payment: atomicPaymentSchema.optional(),
};

/** Nur fuer Spec/OpenAPI: Body von POST /api/v1/Invoice mit den Preisfeldern der Zeilen. */
export const apiInvoiceBodyDocSchema = z.object({
  ...invoiceHeaderFields,
  lines: z.array(apiLineDocSchema).min(1),
  ...finalizeDocFields,
});

/** Nur fuer Spec/OpenAPI: Body von PATCH /api/v1/Invoice/{id}. */
export const apiInvoiceUpdateBodyDocSchema = z
  .object({ ...invoiceHeaderFields, lines: z.array(apiLineDocSchema).min(1).optional() })
  .partial()
  // Wie updateInvoiceSchema: "nicht gesetzt = unveraendert", keine Defaults beim Teil-Update.
  .extend({
    taxScheme: TaxScheme.optional(),
    documentChargePermille: z.number().int().min(0).max(1000).optional(),
    documentChargeCents: z.number().int().nonnegative().optional(),
  })
  .omit({ type: true });

/** Nur fuer Spec/OpenAPI: Body von POST /api/v1/Quote bzw. OrderConfirmation. */
export const apiDocumentBodyDocSchema = documentObjectSchema.extend({ lines: z.array(apiLineDocSchema).min(1) });

/** Nur fuer Spec/OpenAPI: Body von PATCH /api/v1/Quote/{id} bzw. OrderConfirmation/{id}. */
export const apiDocumentUpdateBodyDocSchema = documentObjectSchema
  .omit({ kind: true })
  .partial()
  .extend({
    taxScheme: TaxScheme.optional(),
    documentChargePermille: z.number().int().min(0).max(1000).optional(),
    documentChargeCents: z.number().int().nonnegative().optional(),
    lines: z.array(apiLineDocSchema).min(1).optional(),
  });

export interface PriceInputResult {
  body: unknown;
  mode: "NET" | "GROSS";
  grossTargetCents: number | null;
  predictedDeviationCents: number | null;
}

/** Bruttozielbetrag und Rechnungsbrutto unterscheiden sich; Zahlung muss zum tatsaechlichen Brutto passen. */
export class GrossDeviationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrossDeviationError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;
const nonZero = (v: unknown): boolean => typeof v === "number" && v !== 0;
const without = (r: Rec, keys: string[]): Rec => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
const ONE_FORM = "Genau eine Preisangabe je Position (Netto in Cent/tausendstel Cent, Bruttoeinzelpreis oder Bruttozeilenbetrag).";

export function resolvePriceInput(raw: unknown): PriceInputResult {
  const passthrough: PriceInputResult = { body: raw, mode: "NET", grossTargetCents: null, predictedDeviationCents: null };
  if (!isRec(raw) || !Array.isArray(raw.lines)) return passthrough;
  const rawLines: unknown[] = raw.lines;

  const issues: z.core.$ZodIssue[] = [];
  const add = (path: (string | number)[], message: string): void => {
    issues.push({ code: "custom", path, message } as z.core.$ZodIssue);
  };

  const out: unknown[] = rawLines.slice();
  const grossIdx: number[] = [];
  const netIdx: number[] = [];
  const noPriceIdx: number[] = [];

  rawLines.forEach((l, i) => {
    if (!isRec(l)) return;
    if (l.lineType !== undefined && l.lineType !== "ITEM") return;
    const picked: Rec = {};
    for (const k of Object.keys(apiLinePriceFields)) if (l[k] !== undefined) picked[k] = l[k];
    const parsed = z.object(apiLinePriceFields).safeParse(picked);
    if (!parsed.success) {
      for (const is of parsed.error.issues) add(["lines", i, ...is.path.map((p) => (typeof p === "symbol" ? String(p) : p))], is.message);
      return;
    }
    const hasCent = present(l.unitNetPriceCents);
    const hasMilli = present(l.unitNetPriceMilliCents);
    const hasUnitGross = present(l.unitGrossPriceCents);
    const hasLineGross = present(l.lineGrossCents);
    const net = hasCent || hasMilli;
    const gross = hasUnitGross || hasLineGross;
    if (net && gross) {
      add(["lines", i, hasUnitGross ? "unitGrossPriceCents" : "lineGrossCents"], ONE_FORM);
      return;
    }
    if (hasUnitGross && hasLineGross) {
      add(["lines", i, "lineGrossCents"], ONE_FORM);
      return;
    }
    if (gross) {
      grossIdx.push(i);
      return;
    }
    if (!net) {
      noPriceIdx.push(i);
      return;
    }
    netIdx.push(i);
    if (hasMilli) {
      const milli = l.unitNetPriceMilliCents as number;
      const cents = milliCentsToCents(milli);
      if (hasCent && l.unitNetPriceCents !== cents) {
        add(["lines", i, "unitNetPriceCents"], `Einzelpreis in Cent muss ${cents} sein (Rundung des Preises in tausendstel Cent).`);
        return;
      }
      const rest = without(l, ["unitNetPriceMilliCents"]);
      const normalized = normalizeMilli(milli);
      out[i] = { ...rest, unitNetPriceCents: cents, ...(normalized !== null ? { unitNetPriceMilliCents: normalized } : {}) };
    }
  });

  if (grossIdx.length > 0) {
    for (const i of [...netIdx, ...noPriceIdx]) {
      add(["lines", i], "Bruttozeilen nicht mit Nettozeilen mischen: alle Positionen brauchen dieselbe Preisart.");
    }
    for (const f of ["documentDiscountPermille", "documentDiscountCents", "documentChargePermille", "documentChargeCents"]) {
      if (nonZero(raw[f])) add([f], "Bruttopreise sind nicht mit Belegrabatt oder -aufschlag kombinierbar.");
    }
    const scheme = typeof raw.taxScheme === "string" ? raw.taxScheme : "REGULAR";
    const fallbackCategory = defaultCategoryForScheme(scheme);
    const inputs: { quantityMilli: number; taxRate: number; taxCategory: string; unitGrossPriceCents?: number; lineGrossCents?: number }[] = [];
    let valid = true;
    for (const i of grossIdx) {
      const l = rawLines[i] as Rec;
      for (const f of ["discountPermille", "discountCents"]) {
        if (nonZero(l[f])) {
          add(["lines", i, f], "Bruttopreise sind nicht mit Positionsrabatt kombinierbar.");
          valid = false;
        }
      }
      if (typeof l.quantityMilli !== "number" || !Number.isInteger(l.quantityMilli) || l.quantityMilli <= 0) {
        add(["lines", i, "quantityMilli"], "Bei Bruttopreisen muss die Menge groesser als 0 sein.");
        valid = false;
      }
      if (typeof l.taxRate !== "number") {
        add(["lines", i, "taxRate"], "Bei Bruttopreisen ist der Steuersatz Pflicht.");
        valid = false;
      }
      if (valid) {
        inputs.push({
          quantityMilli: l.quantityMilli as number,
          taxRate: l.taxRate as number,
          taxCategory: typeof l.taxCategory === "string" ? l.taxCategory : fallbackCategory,
          ...(present(l.unitGrossPriceCents) ? { unitGrossPriceCents: l.unitGrossPriceCents as number } : {}),
          ...(present(l.lineGrossCents) ? { lineGrossCents: l.lineGrossCents as number } : {}),
        });
      }
    }
    if (issues.length === 0 && valid) {
      const res = resolveGrossLines(inputs);
      grossIdx.forEach((lineIdx, k) => {
        const rest = without(rawLines[lineIdx] as Rec, ["unitGrossPriceCents", "lineGrossCents", "unitNetPriceMilliCents"]);
        const r = res.lines[k];
        out[lineIdx] = {
          ...rest,
          unitNetPriceCents: r.unitNetPriceCents,
          ...(r.unitNetPriceMilliCents !== null ? { unitNetPriceMilliCents: r.unitNetPriceMilliCents } : {}),
        };
      });
      return { body: { ...raw, lines: out }, mode: "GROSS", grossTargetCents: res.targetGrossCents, predictedDeviationCents: res.deviationCents };
    }
  }

  if (issues.length > 0) throw new z.ZodError(issues);
  return { ...passthrough, body: { ...raw, lines: out } };
}

/**
 * Vor jeder Transaktion: Eine Zahlung beim atomaren Anlegen muss dem tatsaechlichen Rechnungsbrutto
 * entsprechen. Bei einer Brutto-Abweichung ist das Zielbrutto nicht der Rechnungsbetrag.
 */
export function assertGrossPayment(priced: PriceInputResult, paymentAmountCents: number | undefined): void {
  if (priced.mode !== "GROSS" || paymentAmountCents === undefined) return;
  const target = priced.grossTargetCents ?? 0;
  const deviation = priced.predictedDeviationCents ?? 0;
  if (deviation !== 0 && paymentAmountCents !== target + deviation) {
    throw new GrossDeviationError(
      `Die Bruttosumme der Rechnung betraegt ${formatCents(target + deviation)} (Abweichung ${deviation} Cent zum Bruttozielbetrag ${formatCents(target)}); ` +
        `die Zahlung ${formatCents(paymentAmountCents)} passt nicht. Zahlung weglassen (voller Betrag) oder ${formatCents(target + deviation)} angeben.`,
    );
  }
}

/**
 * Antwortfelder bei Bruttoeingabe: Ziel und tatsaechliche Abweichung `Rechnungsbrutto - Ziel`.
 * Bei Netto-Eingabe leer (Antwortform unveraendert). Weicht die tatsaechliche Abweichung von der
 * vorhergesagten ab, wird der tatsaechliche Wert ausgewiesen (Log ohne Belegdaten).
 */
export function grossResponseFields(priced: PriceInputResult, actualGrossCents: number): { grossTargetCents?: number; grossDeviationCents?: number } {
  if (priced.mode !== "GROSS" || priced.grossTargetCents === null) return {};
  const grossDeviationCents = actualGrossCents - priced.grossTargetCents;
  if (grossDeviationCents !== priced.predictedDeviationCents) {
    console.error("[api] Bruttoabweichung weicht von der Vorhersage ab");
  }
  return { grossTargetCents: priced.grossTargetCents, grossDeviationCents };
}
