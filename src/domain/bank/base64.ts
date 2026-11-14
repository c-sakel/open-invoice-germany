/**
 * Strikte Base64-Dekodierung fuer den Kontoauszug-Upload per REST/MCP (Node dekodiert sonst nachsichtig
 * und ignoriert fremde Zeichen). Erlaubt Standard-Alphabet mit Auffuellung; Zeilenumbrueche sind zulaessig.
 */
import { z } from "zod";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64Strict(input: string, maxDecodedBytes: number): Uint8Array {
  const clean = input.replace(/[\r\n]+/g, "");
  const fail = (message: string): never => {
    throw new z.ZodError([{ code: "custom", path: ["contentBase64"], message }]);
  };
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64.test(clean)) fail("contentBase64 ist kein gueltiges Base64.");
  // Dekodierte Laenge vor dem Dekodieren abschaetzen (kein grosser Speicher fuer zu grosse Eingaben).
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const decodedLength = (clean.length / 4) * 3 - padding;
  if (decodedLength > maxDecodedBytes) fail(`Die Datei ist zu gross (maximal ${Math.floor(maxDecodedBytes / (1024 * 1024))} MB).`);
  return new Uint8Array(Buffer.from(clean, "base64"));
}
