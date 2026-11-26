/**
 * POST /api/incoming-invoices — Upload einer Eingangsrechnung aus der Oberfläche (eine Datei je Anfrage).
 * `multipart/form-data` mit `file`. Session-Auth über `src/proxy.ts`; die Organisation kommt aus der Sitzung.
 * Prüfreihenfolge: Same-Origin, Content-Type, Content-Length (Pflicht, höchstens 15 MB + 64 KB) VOR `formData()`,
 * dann `File.size`.
 */
import { getActiveOrg } from "@/lib/org";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";
import { isSameOriginRequest } from "@/lib/http/same-origin";
import { jsonNoStore } from "@/lib/http/account-route";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError } from "@/domain/incoming/errors";
import { MAX_INCOMING_BYTES } from "@/domain/incoming/limits";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { serializeReceiveResult } from "@/api/serializers/incoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MULTIPART_OVERHEAD = 64 * 1024;
const TOO_LARGE = "Datei zu groß (höchstens 15 MB).";

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) return jsonNoStore({ error: "Anfrage nicht zulässig." }, { status: 403 });
  try {
    if (!/^multipart\/form-data\s*;/i.test((req.headers.get("content-type") ?? "").trim())) {
      return jsonNoStore({ error: "Content-Type muss multipart/form-data sein." }, { status: 415 });
    }
    const rawLength = req.headers.get("content-length");
    if (rawLength === null) return jsonNoStore({ error: TOO_LARGE }, { status: 413 });
    const length = Number(rawLength);
    if (rawLength.trim() === "" || !Number.isFinite(length) || length < 0) return jsonNoStore({ error: "Ungültige Anfragelänge." }, { status: 400 });
    if (length > MAX_INCOMING_BYTES + MULTIPART_OVERHEAD) return jsonNoStore({ error: TOO_LARGE }, { status: 413 });
    const org = await getActiveOrg();
    // Grobe Bremse vor dem Einlesen; die Annahme begrenzt je Firma noch einmal.
    rateLimit(`incoming-upload-route:${org.id}`, { limit: 60, windowMs: 60_000 });
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonNoStore({ error: "Keine Datei übermittelt." }, { status: 400 });
    if (file.size > MAX_INCOMING_BYTES) return jsonNoStore({ error: TOO_LARGE }, { status: 413 });
    const result = await receiveIncomingInvoice(org.id, new Uint8Array(await file.arrayBuffer()), {
      fileName: file.name,
      channel: "UPLOAD",
      actor: await requireSessionActor(),
    });
    return jsonNoStore({ result: serializeReceiveResult(result) }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof IncomingFormatError) return jsonNoStore({ error: e.message, code: e.code }, { status: e.code === "TOO_LARGE" ? 413 : 422 });
    if (e instanceof IncomingDuplicateError) {
      return jsonNoStore({ error: e.message, code: "ALREADY_RECEIVED", incomingInvoiceId: e.existingId }, { status: 409 });
    }
    if (e instanceof IncomingBusyError) return jsonNoStore({ error: e.message, code: "BUSY" }, { status: 503, headers: { "Retry-After": "10" } });
    if (e instanceof RateLimitError) {
      return jsonNoStore({ error: "Zu viele Uploads — bitte kurz warten." }, { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    console.error("POST /api/incoming-invoices:", e instanceof Error ? e.name : "unbekannt");
    return jsonNoStore({ error: "Interner Fehler" }, { status: 500 });
  }
}
