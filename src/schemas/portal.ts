/**
 * Schemas des Kundenportals (Einstellungen, Link-Anlage, Token-Format).
 */
import { z } from "zod";

/** Teil-Update: fehlende Felder bleiben unveraendert. */
export const portalSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    linkDays: z.number().int().min(1).max(730),
    showDunnings: z.boolean(),
    showEInvoice: z.boolean(),
    mailSubject: z.string().trim().max(200).nullable(),
    mailBody: z.string().trim().max(5000).nullable(),
  })
  .partial();
export type PortalSettingsInput = z.infer<typeof portalSettingsInputSchema>;

export const createPortalLinkInputSchema = z.object({
  expiresInDays: z.number().int().min(1).max(730).optional(),
});
export type CreatePortalLinkInput = z.infer<typeof createPortalLinkInputSchema>;

/** 32 Byte base64url ohne Padding = 43 Zeichen. */
export const portalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
