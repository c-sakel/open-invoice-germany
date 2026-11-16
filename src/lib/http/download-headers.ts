/**
 * Kopfzeilen fuer die Ausgabe fremder Dateien (Eingangsrechnungen, Anlagen): nie inline, nie
 * zwischenspeichern, kein Erraten des Typs und keine Ausfuehrung von Inhalten im Browser.
 */
import { contentDispositionAttachment } from "./content-disposition";

export function downloadHeaders(fileName: string, mime: string, byteLength: number): Record<string, string> {
  return {
    "content-type": mime,
    "content-length": String(byteLength),
    // attachment mit ASCII-Rueckfall und filename* (RFC 5987); der Name ist vorher bereinigt.
    "content-disposition": contentDispositionAttachment(fileName),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  };
}
