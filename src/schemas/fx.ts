import { z } from "zod";
import { currencyCodeSchema, rateDecimalSchema } from "@/schemas";

export const FxRateSource = z.enum(["BMF_MONTHLY", "ECB_DAILY"]);

export { rateDecimalSchema };

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
