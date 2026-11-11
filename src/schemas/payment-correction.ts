/** Zod-Schemas fuer die Zahlungskorrektur per Gegenbuchung (Phase 16a). */
import { z } from "zod";

export const reversePaymentInputSchema = z.object({
  /** Positiver Betrag in Cent; ohne Angabe wird der noch nicht gegengebuchte Rest zurueckgebucht. */
  amountCents: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(500),
});
export type ReversePaymentInput = z.infer<typeof reversePaymentInputSchema>;
