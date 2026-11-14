/**
 * Portal-Links gehoeren nie in Protokolle: Das Token in der URL ist das Zugangsgeheimnis des Kunden.
 * Protokolltexte (EmailLog, ChangeLog) enthalten statt der URL den Platzhalter "[Portal-Link]"; die
 * versendete Mail traegt den echten Link.
 */
export const PORTAL_LINK_MARKER = "[Portal-Link]";

/** Token = 32 Byte base64url ohne Padding (siehe portalTokenSchema). */
export const PORTAL_TOKEN_LENGTH = Math.ceil((32 * 8) / 6);

const PORTAL_URL = new RegExp(`(?:https?:\\/\\/[^\\s"'<>]*?)?\\/portal\\/[A-Za-z0-9_-]{${PORTAL_TOKEN_LENGTH}}(?![A-Za-z0-9_-])`, "g");

/** Ersetzt jede Portal-URL (mit oder ohne Basis) im Text durch den Platzhalter. */
export function maskPortalLinks(text: string): string {
  return text.replace(PORTAL_URL, PORTAL_LINK_MARKER);
}

/** Setzt den Platzhalter wieder gegen eine URL ein (Wiederversand); ohne URL bleibt der Text unveraendert. */
export function restorePortalLinks(text: string, url: string | null): string {
  if (!url || !text.includes(PORTAL_LINK_MARKER)) return text;
  return text.split(PORTAL_LINK_MARKER).join(url);
}
