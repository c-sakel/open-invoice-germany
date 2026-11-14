/**
 * JSON-Body mit harter Groessengrenze lesen (fuer Routen, bei denen withApi den Body nicht liest,
 * z. B. DELETE mit Pflichtgrund). Der Stream wird gelesen und beim Ueberschreiten der Grenze
 * abgebrochen — auch ohne oder mit falschem Content-Length bzw. bei chunked-Uebertragung.
 */
import { z } from "zod";
import { PayloadTooLargeError, UnsupportedMediaTypeError } from "./errors";

export async function readJsonLimited(req: Request, maxBytes: number): Promise<unknown> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType.trim())) throw new UnsupportedMediaTypeError();
  const tooLarge = () => new PayloadTooLargeError(`Request-Body ueberschreitet das Limit von ${maxBytes} Bytes.`);
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw tooLarge();
  let raw = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new z.ZodError([{ code: "custom", path: [], message: "Ungueltiges JSON im Request-Body." }]);
  }
}
