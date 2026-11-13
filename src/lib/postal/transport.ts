/**
 * Phase 16d — eigener HTTPS-Transport fuer den Briefdienst (LetterXpress API v3).
 *
 * Quelle: API-Dokumentation Stand Juli 2026, S. 3-6 (Content-Type application/json,
 * `auth`-Objekt in JEDEM Request als JSON-Body, auch bei GET/DELETE). Die WHATWG-`fetch`-API
 * verbietet einen Body bei GET; deshalb ein schmaler Transport auf `node:https`.
 *
 * Sicherheit: nur HTTPS (Zugangsdaten stehen im Body), keine Redirects (3xx -> Fehler, Ziel wird
 * nie aufgerufen), Antwortgroesse begrenzt, Gesamt-Timeout, Fehlertexte ohne Body. Notschalter:
 * `defaultTransport()` wirft unter Vitest oder mit `POSTAL_NETWORK=0` bei JEDEM Aufruf.
 */
import https from "node:https";

export const LXP_BASE_URL = "https://api.letterxpress.de/v3";

export type LxpMethod = "GET" | "POST" | "DELETE";

export interface LxpTransportRequest {
  method: LxpMethod;
  path: string;
  query?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

export interface LxpTransportResponse {
  status: number;
  json: unknown;
}

export type LxpTransport = (req: LxpTransportRequest) => Promise<LxpTransportResponse>;

export class PostalNetworkForbiddenError extends Error {
  constructor() {
    super("Netzzugriff auf den Briefdienst ist gesperrt (Testlauf oder POSTAL_NETWORK=0).");
    this.name = "PostalNetworkForbiddenError";
  }
}

export class PostalTransportError extends Error {
  constructor(
    msg: string,
    readonly kind: "timeout" | "network" | "redirect" | "too_large" | "bad_json",
  ) {
    super(msg);
    this.name = "PostalTransportError";
  }
}

function networkForbidden(): boolean {
  return Boolean(process.env.VITEST) || process.env.POSTAL_NETWORK === "0";
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function createHttpsTransport(opts: {
  requestImpl?: typeof https.request;
  baseUrl?: string;
  maxResponseBytes?: number;
} = {}): LxpTransport {
  const base = new URL(opts.baseUrl ?? LXP_BASE_URL);
  // Ohne injizierte Implementierung (= echtes Netz) ist ausschliesslich HTTPS erlaubt.
  if (!opts.requestImpl && base.protocol !== "https:") {
    throw new Error("Nur HTTPS ist erlaubt.");
  }
  const requestImpl = opts.requestImpl;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return (req) =>
    new Promise<LxpTransportResponse>((resolve, reject) => {
      // Notbremse im Request-Pfad: echtes Netz (keine injizierte Implementierung) nie unter Vitest/POSTAL_NETWORK=0.
      if (!requestImpl && networkForbidden()) {
        reject(new PostalNetworkForbiddenError());
        return;
      }
      const url = new URL(base.toString().replace(/\/+$/, "") + req.path);
      for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
      const payload = Buffer.from(JSON.stringify(req.body), "utf8");
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const impl = requestImpl ?? https.request;
      const r = impl(
        url,
        {
          method: req.method,
          timeout: req.timeoutMs,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "content-length": String(payload.byteLength),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            finish(() => {
              r.destroy();
              reject(new PostalTransportError(`Weiterleitung (${status}) nicht erlaubt.`, "redirect"));
            });
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.resume();
            finish(() => {
              r.destroy();
              reject(new PostalTransportError("Antwort zu gross.", "too_large"));
            });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.byteLength;
            if (total > maxBytes) {
              finish(() => {
                r.destroy();
                reject(new PostalTransportError("Antwort zu gross.", "too_large"));
              });
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            finish(() => {
              try {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({ status, json: JSON.parse(text) as unknown });
              } catch {
                reject(new PostalTransportError("Antwort ist kein gueltiges JSON.", "bad_json"));
              }
            });
          });
          res.on("error", () => {
            finish(() => reject(new PostalTransportError("Netzwerkfehler beim Lesen der Antwort.", "network")));
          });
        },
      );
      const timer = setTimeout(() => {
        finish(() => {
          r.destroy();
          reject(new PostalTransportError("Zeitueberschreitung.", "timeout"));
        });
      }, req.timeoutMs);
      r.on("timeout", () => {
        finish(() => {
          r.destroy();
          reject(new PostalTransportError("Zeitueberschreitung.", "timeout"));
        });
      });
      r.on("error", () => {
        finish(() => reject(new PostalTransportError("Netzwerkfehler.", "network")));
      });
      r.end(payload);
    });
}

/** Produktiver Transport; prueft den Notschalter bei jedem Aufruf (nicht beim Erzeugen). */
export function defaultTransport(): LxpTransport {
  return (req) => {
    if (networkForbidden()) {
      return Promise.reject(new PostalNetworkForbiddenError());
    }
    return createHttpsTransport()(req);
  };
}
