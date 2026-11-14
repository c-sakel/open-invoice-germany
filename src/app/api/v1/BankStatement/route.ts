/**
 * /api/v1/BankStatement — Kontoauszug-Import (CAMT.053/.054) und Importliste.
 * POST: JSON `{ contentBase64, fileName?, dryRun? }` (Datei als Base64, dekodiert hoechstens 10 MB, Body
 * hoechstens 14 MB); `dryRun` liefert die Vorschau ohne zu speichern. Es wird nichts gebucht; die Umsaetze
 * landen in der Warteschlange. Scope `write` wie das CSV-Import und die Zahlungserfassung.
 */
import { NextResponse } from "next/server";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { withBankImportErrors } from "@/api/bank-errors";
import { bankImportResultSchema, bankStatementSchema, serializeBankImportResult, serializeBankStatement } from "@/api/serializers/bank";
import { decodeBase64Strict } from "@/domain/bank/base64";
import { importBankStatement } from "@/domain/bank/import";
import { MAX_CAMT_BYTES } from "@/domain/bank/errors";
import { bankStatementListQuerySchema, listBankImports } from "@/domain/bank/list";
import { BANK_IMPORT_MAX_BASE64, bankImportInputSchema } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Base64 14 MB plus JSON-Huelle. */
export const BANK_IMPORT_MAX_BODY_BYTES = BANK_IMPORT_MAX_BASE64 + 4096;

export const GET = withApi(async (req, ctx) => {
  const result = await listBankImports(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
  return apiList(result.rows.map(serializeBankStatement), { total: result.total, limit: result.limit, offset: 0, nextCursor: result.nextCursor });
}, { scope: "read" });

export const POST = withApi((_req, ctx): Promise<NextResponse> =>
  withBankImportErrors(async () => {
    const input = bankImportInputSchema.parse(ctx.body);
    const bytes = decodeBase64Strict(input.contentBase64, MAX_CAMT_BYTES);
    const result = await importBankStatement(ctx.orgId, bytes, { actor: ctx.actor, source: "API", fileName: input.fileName, dryRun: input.dryRun });
    return apiData(serializeBankImportResult(result), result.status === "imported" ? 201 : 200);
  }),
{ scope: "write", maxBodyBytes: BANK_IMPORT_MAX_BODY_BYTES });

export const spec = {
  list: {
    path: "/api/v1/BankStatement",
    method: "GET",
    summary: "Importierte Kontoauszuege auflisten (neueste zuerst, Cursor)",
    scope: "read",
    request: { query: bankStatementListQuerySchema },
    response: apiListResponseSchema(bankStatementSchema, { sync: true }),
    errors: [400, 401, 403, 429],
  },
  import: {
    path: "/api/v1/BankStatement",
    method: "POST",
    summary: "Kontoauszug (CAMT.053/.054, XML) als Base64 importieren; dryRun=true liefert nur die Vorschau. Es wird nichts gebucht. Datei höchstens 10 MB (Body 14 MB)",
    scope: "write",
    request: { body: bankImportInputSchema },
    response: apiDataResponseSchema(bankImportResultSchema),
    errors: [400, 401, 403, 409, 413, 422, 429],
    errorNotes: {
      409: "ALREADY_IMPORTED: dieselbe Datei wurde schon importiert (details.importId).",
      422: "Dateifehler mit fachlichem Code in error.reason (z. B. FORBIDDEN_MARKUP, ZIP_NOT_SUPPORTED, NOT_CAMT, UNSUPPORTED_VERSION).",
    },
  },
} satisfies Record<string, RouteSpec>;
