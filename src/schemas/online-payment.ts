/**
 * Schemas der Online-Zahlung (Einstellungen, Zugang, Vorgaben je Zahlungsart/Kunde).
 */
import { z } from "zod";
import { TWO_DECIMAL_CURRENCIES } from "@/lib/payment/amount";
import { ONLINE_PROVIDERS } from "@/lib/payment/types";

export const onlineProviderSchema = z.enum(ONLINE_PROVIDERS);

/** Vorgabe je Org/Kunde/Zahlungsart: NONE = ausdruecklich kein Bezahllink. */
export const onlineProviderChoiceSchema = z.enum(["NONE", ...ONLINE_PROVIDERS]);
export type OnlineProviderChoice = z.infer<typeof onlineProviderChoiceSchema>;

/** Teil-Update der Organisationsvorgaben; nur uebergebene Felder aendern sich. */
export const onlinePaymentSettingsInputSchema = z
  .strictObject({
    defaultProvider: onlineProviderChoiceSchema,
    showOnPdf: z.boolean(),
    showInMail: z.boolean(),
    showInPortal: z.boolean(),
  })
  .partial();
export type OnlinePaymentSettingsInput = z.infer<typeof onlinePaymentSettingsInputSchema>;

/** Zugangsschluessel: nur Zeichensatz/Laenge; der Modus wird vom Adapter aus dem Praefix gelesen. */
export const providerApiKeySchema = z
  .string()
  .trim()
  .min(30)
  .max(200)
  .refine((v) => /^(test|live)_[A-Za-z0-9]+$/.test(v), "Schluessel hat kein gueltiges Format.");

/** Methoden-Ids des Anbieters (z. B. "creditcard"); null/leer = alle aktiven Methoden des Anbieters. */
const methodIdSchema = z.string().refine((v) => /^[a-z0-9_]{1,32}$/.test(v), "Ungueltige Methoden-Id.");

export const providerOptionsInputSchema = z
  .strictObject({
    allowedMethods: z.array(methodIdSchema).max(40).nullable(),
    currencies: z.array(z.enum(TWO_DECIMAL_CURRENCIES)).min(1).max(TWO_DECIMAL_CURRENCIES.length),
  })
  .partial();
export type ProviderOptionsInput = z.infer<typeof providerOptionsInputSchema>;

/** Format des Link-Tokens (32 Byte base64url ohne Padding). */
export const payLinkTokenSchema = z.string().refine((v) => /^[A-Za-z0-9_-]{43}$/.test(v), "Ungueltiges Token.");
