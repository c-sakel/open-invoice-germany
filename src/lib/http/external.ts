/**
 * Abruf fester, oeffentlicher Quellen (z. B. EZB-Referenzkurse) — bewusst eng gehalten:
 * Timeout, hoechstens wenige Weiterleitungen auf DENSELBEN Host, Antwortgroesse begrenzt,
 * alles ausser HTTP 200 ist ein Fehler. Die URL stammt immer aus einer Konstante im Code,
 * nie aus Benutzereingaben (kein SSRF-Pfad).
 */

export class ExternalHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ExternalHttpError";
  }
}

export interface ExternalFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Obergrenze der Antwortgroesse in Bytes (Standard 2 MiB). */
  maxBytes?: number;
  /** Standard GET. POST nur mit fester Ziel-URL aus dem Code (z. B. VIES); Weiterleitungen sind dann verboten. */
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ExternalHttpError(`Antwort zu gross (${declared} Bytes, erlaubt ${maxBytes}).`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ExternalHttpError(`Antwort zu gross (mehr als ${maxBytes} Bytes).`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function externalFetch(url: string, opts: ExternalFetchOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const method = opts.method ?? "GET";
  const origin = new URL(url);
  if (origin.protocol !== "https:") throw new ExternalHttpError("Nur HTTPS erlaubt.");

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        ...(method === "POST" ? { body: opts.body, headers: opts.headers } : opts.headers ? { headers: opts.headers } : {}),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new ExternalHttpError(`Abruf fehlgeschlagen: ${reason}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (method === "POST") throw new ExternalHttpError("Weiterleitung bei POST abgelehnt.", res.status);
      if (!location) throw new ExternalHttpError("Weiterleitung ohne Ziel.", res.status);
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.host !== origin.host) {
        throw new ExternalHttpError("Weiterleitung auf anderen Host abgelehnt.", res.status);
      }
      current = next.toString();
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new ExternalHttpError(`HTTP ${res.status}`, res.status);
    }
    try {
      return await readLimited(res, maxBytes);
    } catch (e) {
      if (e instanceof ExternalHttpError) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new ExternalHttpError(`Antwort nicht lesbar: ${reason}`);
    }
  }
  throw new ExternalHttpError("Zu viele Weiterleitungen.");
}
