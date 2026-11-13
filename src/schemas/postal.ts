/**
 * Phase 16d — Schemas fuer den Postversand (Einstellungen, Preisabfrage).
 * Geld in Cent; Zugangsdaten nur ueber die UI (nie ueber API/MCP).
 */
import { z } from "zod";

export const POSTAL_MODES = ["DRY_RUN", "TEST", "LIVE"] as const;
export type PostalMode = (typeof POSTAL_MODES)[number];
export const DELIVERY_CHANNELS = ["EMAIL", "POST", "EMAIL_AND_POST"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export const STAGE_CHANNELS = ["CUSTOMER", ...DELIVERY_CHANNELS] as const;
export type StageChannel = (typeof STAGE_CHANNELS)[number];

/** Druckoptionen — die einzigen Felder, die API/MCP setzen duerfen (strict: andere Schluessel -> Fehler). */
export const postalPrintOptionsSchema = z
  .object({
    color: z.enum(["1", "4"]),
    duplex: z.boolean(),
    shipping: z.enum(["auto", "national", "international"]),
    registeredDefault: z.enum(["r1", "r2"]).nullable(),
  })
  .partial()
  .strict();
export type PostalPrintOptionsInput = z.infer<typeof postalPrintOptionsSchema>;

/** UI-Einstellungen; alle Felder optional, fehlende Felder lassen den gespeicherten Stand unveraendert. */
export const postalSettingsUiSchema = z
  .object({
    color: z.enum(["1", "4"]),
    duplex: z.boolean(),
    shipping: z.enum(["auto", "national", "international"]),
    registeredDefault: z.enum(["r1", "r2"]).nullable(),
    username: z.string().trim().min(1).max(100),
    apiKey: z.string().trim().min(8).max(200),
    clearApiKey: z.boolean(),
    enabled: z.boolean(),
    mode: z.enum(POSTAL_MODES),
    autoDunningPost: z.boolean(),
    monthlyBudgetCents: z.number().int().min(0).max(100_000_00).nullable(),
    acknowledgeCosts: z.boolean(),
  })
  .partial()
  .strict();
export type PostalSettingsUiInput = z.infer<typeof postalSettingsUiSchema>;

const boolish = z.union([
  z.boolean(),
  z.enum(["true", "1"]).transform(() => true),
  z.enum(["false", "0"]).transform(() => false),
]);

export const postalPriceQuerySchema = z
  .object({
    pages: z.coerce.number().int().min(1).max(500),
    color: z.enum(["1", "4"]).default("1"),
    duplex: boolish.default(false),
    shipping: z.enum(["national", "international"]).default("national"),
    registered: z.enum(["r1", "r2"]).optional(),
  })
  .refine((v) => !(v.registered && v.shipping === "international"), {
    path: ["registered"],
    message: "Einschreiben nur national.",
  });
export type PostalPriceQuery = z.infer<typeof postalPriceQuerySchema>;
