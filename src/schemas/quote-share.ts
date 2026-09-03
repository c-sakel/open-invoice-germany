/**
 * Zod-Schemas fuer Angebotslinks, Online-Entscheidung und die zugehoerigen
 * Dokument-Einstellungen (Phase 3b, Task 2). Domain-Funktionen parsen ihre
 * Eingabe selbst (Lastenheft 50/55) — kein Bypass ueber Route oder MCP.
 */
import { z } from "zod";

/** Automatik nach Online-Annahme eines Angebots. */
export const OnQuoteAccept = z.enum(["NONE", "ORDER_CONFIRMATION", "INVOICE"]);
export type OnQuoteAccept = z.infer<typeof OnQuoteAccept>;

export const documentSettingsInputSchema = z.object({
  onQuoteAccept: OnQuoteAccept.default("NONE"),
  /** Gueltigkeitsdauer neu erzeugter Angebotslinks in Tagen (Default, ueberschreibbar je Link). */
  shareLinkDays: z.coerce.number().int().min(1).max(365).default(30),
  /** Ob die IP-Adresse des Entscheiders beim Annehmen/Ablehnen gespeichert wird. */
  storeAcceptIp: z.boolean().default(false),
});
export type DocumentSettingsInput = z.infer<typeof documentSettingsInputSchema>;

export const createShareLinkInputSchema = z.object({
  /** Ueberschreibt DocumentSettings.shareLinkDays fuer diesen einen Link. */
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});
export type CreateShareLinkInput = z.infer<typeof createShareLinkInputSchema>;

const deciderEmail = z.string().trim().pipe(z.email("Ungueltige E-Mail-Adresse"));

export const decideOfferInputSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED"]),
  name: z.string().trim().min(1, "Name fehlt").max(200),
  email: deciderEmail,
  comment: z.string().trim().max(2000).optional(),
});
export type DecideOfferInput = z.infer<typeof decideOfferInputSchema>;
