/**
 * POST /api/bank-statements — Kontoauszug-Upload (CAMT.053/.054) fuer die eingeloggte Oberflaeche.
 * `multipart/form-data`: `file`, `mode=preview|commit`. Session-Auth ueber `src/proxy.ts`; die Organisation
 * kommt aus der Sitzung. Pruefreihenfolge wie beim CSV-Import: Same-Origin, Content-Type, Content-Length
 * (Pflicht, hoechstens 10 MB + 64 KB) VOR `formData()`, dann `File.size`. Es wird keine Datei gespeichert.
 */
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { isSameOriginRequest } from "@/lib/http/same-origin";
import { jsonNoStore } from "@/lib/http/account-route";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { CamtFormatError, MAX_CAMT_BYTES } from "@/domain/bank/errors";
import { BankImportConflictError, BankImportDuplicateError, importBankStatement } from "@/domain/bank/import";
import { serializeBankImportResult } from "@/api/serializers/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MULTIPART_OVERHEAD = 64 * 1024;
const TOO_LARGE = "Datei zu groß (höchstens 10 MB).";

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) return jsonNoStore({ error: "Anfrage nicht zulässig." }, { status: 403 });
  try {
    if (!/^multipart\/form-data\s*;/i.test((req.headers.get("content-type") ?? "").trim())) {
      return jsonNoStore({ error: "Content-Type muss multipart/form-data sein." }, { status: 415 });
    }
    const rawLength = req.headers.get("content-length");
    if (rawLength === null) return jsonNoStore({ error: TOO_LARGE }, { status: 413 });
    const length = Number(rawLength);
    if (rawLength.trim() === "" || !Number.isFinite(length) || length < 0) {
      return jsonNoStore({ error: "Ungültige Anfragelänge." }, { status: 400 });
    }
    if (length > MAX_CAMT_BYTES + MULTIPART_OVERHEAD) return jsonNoStore({ error: TOO_LARGE }, { status: 413 });
    const org = await getActiveOrg();
    // Grobe Bremse VOR dem Einlesen des Bodies (der Import selbst begrenzt je Organisation noch einmal).
    rateLimit(`bank-import-route:${org.id}`, { limit: 60, windowMs: 60_000 });
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonNoStore({ error: "Keine Datei übermittelt." }, { status: 400 });
    if (file.size > MAX_CAMT_BYTES) return jsonNoStore({ error: TOO_LARGE }, { status: 413 });
    const parsedMode = z.enum(["preview", "commit"]).safeParse(form.get("mode") ?? "preview");
    if (!parsedMode.success) return jsonNoStore({ error: "mode muss preview oder commit sein." }, { status: 400 });
    const mode = parsedMode.data;
    const result = await importBankStatement(org.id, new Uint8Array(await file.arrayBuffer()), {
      actor: (await getCurrentUserId()) ?? "system",
      source: "UI",
      fileName: file.name,
      dryRun: mode === "preview",
    });
    return jsonNoStore({ result: serializeBankImportResult(result) }, { status: result.status === "imported" ? 201 : 200 });
  } catch (e) {
    if (e instanceof CamtFormatError) return jsonNoStore({ error: e.message, code: e.code }, { status: 422 });
    if (e instanceof BankImportDuplicateError) {
      return jsonNoStore({ error: e.message, code: "ALREADY_IMPORTED", importId: e.importId }, { status: 409 });
    }
    if (e instanceof BankImportConflictError) return jsonNoStore({ error: e.message }, { status: 409 });
    if (e instanceof RateLimitError) {
      return jsonNoStore({ error: "Zu viele Importe — bitte kurz warten." }, { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    console.error("POST /api/bank-statements:", e instanceof Error ? e.name : "unbekannt");
    return jsonNoStore({ error: "Interner Fehler" }, { status: 500 });
  }
}
