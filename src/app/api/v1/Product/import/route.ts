/**
 * POST /api/v1/Product/import — CSV-Import von Produkte (Phase 18b, Task 6). Body JSON
 * `{ csv, fileName?, dryRun?, expectedHash? }`; `dryRun` ist standardmaessig `true` (Vorschau).
 * Commit (`dryRun: false`) nur mit `Idempotency-Key`; alles oder nichts, nur Anlage (kein Update).
 */
import { withApi } from "@/api/auth";
import { handleRestImport, IMPORT_MAX_BODY_BYTES } from "@/api/import-route";
import { importRequestSchema } from "@/domain/import/run";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (req, ctx) => handleRestImport(req, ctx, "products"), {
  scope: "write",
  maxBodyBytes: IMPORT_MAX_BODY_BYTES,
});

export const spec = {
  import: {
    path: "/api/v1/Product/import",
    method: "POST",
    summary: "Produkte per CSV importieren: dryRun (Standard true) liefert die Vorschau mit Fehlern je Zeile/Spalte, dryRun=false legt alle Zeilen an oder keine (Idempotency-Key Pflicht; nur Anlage, kein Update; höchstens 2 MB und 2.000 Zeilen)",
    scope: "write",
    request: { body: importRequestSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 409, 413, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
