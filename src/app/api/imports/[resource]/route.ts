/**
 * /api/imports/<contacts|products> — CSV-Import fuer die eingeloggte Oberflaeche (Phase 18b, Task 6).
 * GET liefert die Vorlage, POST (`multipart/form-data`: `file`, `mode=preview|commit`, `expectedHash?`)
 * die Vorschau bzw. den Import. Session-Auth ueber `src/proxy.ts`; die Organisation kommt aus der
 * Sitzung, nie aus der Datei. Groessenpruefung VOR `formData()` (Content-Length Pflicht), dann
 * `File.size`, dann erst Dekodieren. Es wird keine Datei gespeichert.
 */
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { csvResponse } from "@/lib/http/csv-response";
import { jsonNoStore } from "@/lib/http/account-route";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { CONTACT_IMPORT_COLUMNS, PRODUCT_IMPORT_COLUMNS, type ImportColumn } from "@/domain/import/columns";
import { sanitizeFileName } from "@/domain/import/types";
import { CsvFormatError, CsvLimitError, MAX_IMPORT_BYTES, decodeCsvBytes } from "@/domain/import/parse-csv";
import { ImportAlreadyDoneError, ImportHashMismatchError, ImportRejectedError, runCsvImport } from "@/domain/import/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resourceSchema = z.enum(["contacts", "products"]);
const MULTIPART_OVERHEAD = 64 * 1024;

const TEMPLATES: Record<"contacts" | "products", { file: string; columns: readonly ImportColumn[]; example: Record<string, string> }> = {
  contacts: {
    file: "vorlage-kunden.csv",
    columns: CONTACT_IMPORT_COLUMNS,
    example: { name: "Muster GmbH", street: "Beispielweg 1", postalCode: "12345", city: "Musterstadt", country: "DE", customerType: "Firma" },
  },
  products: {
    file: "vorlage-produkte.csv",
    columns: PRODUCT_IMPORT_COLUMNS,
    example: { name: "Beispielleistung", unit: "Std", netPrice: "95,00", taxRate: "19" },
  },
};

/** Nur same-origin: `Sec-Fetch-Site` (Browser) bzw. `Origin` gegen den Host; ohne beide (kein Browser) wie bisher Cookie-Auth. */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

function templateCsv(resource: "contacts" | "products"): string {
  const t = TEMPLATES[resource];
  const head = t.columns.map((c) => c.header).join(";");
  const row = t.columns.map((c) => t.example[c.key] ?? "").join(";");
  return `${head}\r\n${row}\r\n`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ resource: string }> }) {
  const parsed = resourceSchema.safeParse((await params).resource);
  if (!parsed.success) return jsonNoStore({ error: "Nicht gefunden" }, { status: 404 });
  return csvResponse(templateCsv(parsed.data), TEMPLATES[parsed.data].file);
}

export async function POST(req: Request, { params }: { params: Promise<{ resource: string }> }) {
  const parsed = resourceSchema.safeParse((await params).resource);
  if (!parsed.success) return jsonNoStore({ error: "Nicht gefunden" }, { status: 404 });
  const resource = parsed.data;
  if (!isSameOriginRequest(req)) return jsonNoStore({ error: "Anfrage nicht zulässig." }, { status: 403 });
  try {
    const rawLength = req.headers.get("content-length");
    const length = Number(rawLength);
    if (rawLength === null) return jsonNoStore({ error: "Datei zu groß (höchstens 2 MB)." }, { status: 413 });
    if (rawLength.trim() === "" || !Number.isFinite(length) || length < 0) {
      return jsonNoStore({ error: "Ungültige Anfragelänge." }, { status: 400 });
    }
    if (length > MAX_IMPORT_BYTES + MULTIPART_OVERHEAD) {
      return jsonNoStore({ error: "Datei zu groß (höchstens 2 MB)." }, { status: 413 });
    }
    const org = await getActiveOrg();
    // Grobe Bremse VOR dem Einlesen des Bodies (Vorschau/Commit-Limits greifen danach je Org).
    rateLimit(`csv-import-route:${org.id}`, { limit: 60, windowMs: 60_000 });
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonNoStore({ error: "Keine Datei übermittelt." }, { status: 400 });
    if (file.size > MAX_IMPORT_BYTES) return jsonNoStore({ error: "Datei zu groß (höchstens 2 MB)." }, { status: 413 });
    const allowRepeat = form.get("allowRepeat") === "true";
    const mode = form.get("mode") === "commit" ? "commit" : "preview";
    const hashRaw = form.get("expectedHash");
    const expectedHash = typeof hashRaw === "string" && hashRaw !== "" ? hashRaw : undefined;
    if (mode === "commit" && expectedHash === undefined) {
      return jsonNoStore({ error: "Prüfwert der Vorschau fehlt." }, { status: 400 });
    }
    if (expectedHash !== undefined && !/^[0-9a-f]{64}$/.test(expectedHash)) {
      return jsonNoStore({ error: "Ungültiger Prüfwert." }, { status: 400 });
    }
    const { text, encoding } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
    const result = await runCsvImport(
      org.id,
      resource,
      { text, encoding, fileName: sanitizeFileName(file.name) ?? undefined, dryRun: mode === "preview", expectedHash, allowRepeat },
      { actor: (await getCurrentUserId()) ?? "system", source: "UI", withSample: true },
    );
    if (result.status === "imported") return jsonNoStore({ created: result.created, preview: result.preview }, { status: 201 });
    return jsonNoStore({ preview: result.preview });
  } catch (e) {
    if (e instanceof ImportRejectedError) return jsonNoStore({ error: e.message, preview: e.preview }, { status: 422 });
    if (e instanceof CsvLimitError) return jsonNoStore({ error: e.message }, { status: 413 });
    if (e instanceof CsvFormatError) return jsonNoStore({ error: e.message, line: e.line ?? null }, { status: 400 });
    if (e instanceof ImportAlreadyDoneError) return jsonNoStore({ error: e.message, code: "ALREADY_IMPORTED" }, { status: 409 });
    if (e instanceof ImportHashMismatchError) return jsonNoStore({ error: e.message }, { status: 409 });
    if (e instanceof RateLimitError) {
      return jsonNoStore({ error: "Zu viele Importe — bitte kurz warten." }, { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    console.error("POST /api/imports:", e instanceof Error ? e.name : "unbekannt");
    return jsonNoStore({ error: "Interner Fehler" }, { status: 500 });
  }
}
