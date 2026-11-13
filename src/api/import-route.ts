/**
 * Gemeinsamer Handler der REST-Importrouten (Phase 18b, Task 6): `POST /api/v1/Contact/import` und
 * `/api/v1/Product/import`. Body `importRequestSchema` (JSON, `dryRun` Default `true`); der Commit
 * verlangt einen `Idempotency-Key` (die Wiederholung liefert dieselbe Antwort, ohne erneut anzulegen).
 * Die Vorschau enthaelt nie Beispielzeilen (`sample`) — Zellwerte sind personenbezogen.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApiContext } from "./auth";
import { apiData } from "./response";
import { importRequestSchema, runCsvImport, ImportRejectedError, ImportAlreadyDoneError, ImportHashMismatchError, type ImportResource } from "@/domain/import/run";

export const IMPORT_MAX_BODY_BYTES = 3 * 1024 * 1024;

export async function handleRestImport(req: Request, ctx: ApiContext, resource: ImportResource): Promise<NextResponse> {
  const input = importRequestSchema.parse(ctx.body);
  if (!input.dryRun && !req.headers.get("idempotency-key")?.trim()) {
    throw new z.ZodError([{ code: "custom", path: ["Idempotency-Key"], message: "Idempotency-Key ist beim Import Pflicht." }]);
  }
  if (!input.dryRun && !input.expectedHash) {
    throw new z.ZodError([{ code: "custom", path: ["expectedHash"], message: "expectedHash (fileHash der Vorschau) ist beim Import Pflicht." }]);
  }
  try {
    const result = await runCsvImport(
      ctx.orgId,
      resource,
      { text: input.csv, fileName: input.fileName, dryRun: input.dryRun, expectedHash: input.expectedHash, allowRepeat: input.allowRepeat },
      { actor: ctx.actor, source: "API" },
    );
    if (result.status === "imported") return apiData({ created: result.created, preview: result.preview }, 201);
    return apiData({ preview: result.preview });
  } catch (e) {
    if (e instanceof ImportRejectedError) {
      return NextResponse.json(
        { error: { code: "UNPROCESSABLE", message: e.message, details: { errorCount: e.preview.errorCount, errors: e.preview.errors } } },
        { status: 422 },
      );
    }
    if (e instanceof ImportAlreadyDoneError || e instanceof ImportHashMismatchError) {
      return NextResponse.json({ error: { code: "CONFLICT", message: e.message } }, { status: 409 });
    }
    throw e;
  }
}
