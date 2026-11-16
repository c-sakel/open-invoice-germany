/**
 * Base64-Eingang fuer REST und MCP: die Groesse wird vor dem Dekodieren geprueft (zu gross -> 413
 * bzw. Hinweis), ungueltiges Base64 ist ein Validierungsfehler (400).
 */
import { decodeBase64Strict } from "@/domain/bank/base64";
import { IncomingFormatError } from "./errors";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeIncomingBase64(contentBase64: string, maxBytes: number): Uint8Array {
  const clean = contentBase64.replace(/[\r\n]+/g, "");
  if (clean.length > 0 && clean.length % 4 === 0 && BASE64.test(clean)) {
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    if ((clean.length / 4) * 3 - padding > maxBytes) {
      throw new IncomingFormatError(`Die Datei ist zu gross (maximal ${Math.floor(maxBytes / (1024 * 1024))} MB).`, "TOO_LARGE");
    }
  }
  return decodeBase64Strict(contentBase64, maxBytes);
}
