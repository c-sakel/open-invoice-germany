/**
 * Schreibt einen Eintrag des Anfrageprotokolls (Phase 12d, Task 2). Liest zuerst die
 * Einstellungen der Organisation: ohne `logRequests` oder fuer ausgeschlossene Pfade
 * (Doku, OpenAPI, ping, das Protokoll selbst — `shouldLogPath`) wird nichts geschrieben.
 * Bodies werden nur bei `logBodies` gespeichert — der Request-Body wird dann immer
 * versucht, der Response-Body nur, wenn der Aufrufer einen mitgegeben hat (die Regel
 * "nur bei status >= 400" setzt der Aufrufer durch, `withApi` klont die Antwort nur dort).
 * Protokollieren darf eine Anfrage nie zum Scheitern bringen — die Funktion wirft nie.
 */
import { dbInternal } from "@/lib/db";
import { loadApiSettings } from "./settings";
import { prepareBody, shouldLogPath } from "./redact";

export interface ApiLogInput {
  orgId: string;
  apiKeyId: string | null;
  requestId: string;
  method: string;
  path: string;
  query: string | null;
  status: number;
  durationMs: number;
  errorCode: string | null;
  ip: string | null;
  userAgent: string | null;
  requestBody: string | null; // roher Text, noch ungekuerzt
  responseBody: string | null; // nur vom Aufrufer gesetzt, wenn status >= 400
}

export async function logApiRequest(input: ApiLogInput): Promise<void> {
  try {
    const settings = await loadApiSettings(input.orgId);
    if (!settings.logRequests) return;
    if (!shouldLogPath(input.path)) return;

    let requestBody: string | null = null;
    let responseBody: string | null = null;
    let bodyTruncated = false;
    if (settings.logBodies) {
      const req = prepareBody(input.requestBody);
      requestBody = req.text;
      bodyTruncated = bodyTruncated || req.truncated;
      if (input.responseBody != null) {
        const res = prepareBody(input.responseBody);
        responseBody = res.text;
        bodyTruncated = bodyTruncated || res.truncated;
      }
    }

    await dbInternal.apiRequestLog.create({
      data: {
        orgId: input.orgId,
        apiKeyId: input.apiKeyId,
        requestId: input.requestId,
        method: input.method,
        path: input.path,
        query: input.query,
        status: input.status,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
        ip: input.ip,
        userAgent: input.userAgent,
        requestBody,
        responseBody,
        bodyTruncated,
      },
      select: { id: true },
    });
  } catch {
    // Protokollieren darf die Anfrage nie kippen.
  }
}
