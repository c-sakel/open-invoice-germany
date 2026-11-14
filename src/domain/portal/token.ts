/**
 * Token des Kundenportals. Gleiche Erzeugung/Hashing wie beim Angebotslink; in der Datenbank liegt
 * nur der SHA-256-Hash (Aufloesung) und das verschluesselte Token (Wiederabruf durch den Betreiber).
 */
import { portalTokenSchema } from "@/schemas/portal";
export { generateToken, hashToken } from "@/domain/quote-share/token";

/** Formatpruefung ohne Datenbankzugriff. */
export function isWellFormedPortalToken(token: unknown): token is string {
  return portalTokenSchema.safeParse(token).success;
}
