import { z } from "zod";
import { currencyCodeSchema } from "@/schemas";
import { parseRateMicros } from "@/domain/fx/decimal";

export const FxRateSource = z.enum(["BMF_MONTHLY", "ECB_DAILY"]);

/** Kurs als Dezimalstring (Punkt oder Komma, max. 6 Nachkommastellen) -> Integer-Micros, 1..2e9. */
export const rateDecimalSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}([.,]\d{1,6})?$/, "Kurs: bis 4 Vorkomma- und 6 Nachkommastellen")
  .transform((s, ctx) => {
    try {
      return parseRateMicros(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : "Kurs ungueltig" });
      return z.NEVER;
    }
  });

/** Kalendertag YYYY-MM-DD als UTC-Mitternacht. */
const utcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum: YYYY-MM-DD")
  .transform((s, ctx) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      ctx.addIssue({ code: "custom", message: "Datum ungueltig" });
      return z.NEVER;
    }
    return d;
  });

export const exchangeRateQuerySchema = z.object({
  currency: currencyCodeSchema,
  date: utcDateSchema,
});

export const exchangeRateUpsertSchema = z.object({
  source: z.enum(["ECB", "MONTHLY"]),
  currency: currencyCodeSchema,
  rateDate: utcDateSchema,
  rate: rateDecimalSchema,
  note: z.string().trim().max(500).optional(),
});

export type ExchangeRateUpsert = z.infer<typeof exchangeRateUpsertSchema>;
