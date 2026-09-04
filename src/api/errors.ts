/**
 * Fehler-Mapping fuer /api/v1/* (Phase 10, Task 1, task-1-facts.md "Fehlerformat").
 * Einheitliches Format: `{ error: { code, message, details? } }`.
 *
 * Erweiterbarkeit fuer Tasks 2-5: viele bestehende Domain-Fehlerklassen (z. B.
 * DunningStageError) tragen bereits eine `status`-Eigenschaft (Konvention aus den
 * bisherigen internen `/api/*`-Routen) — diese werden hier per Duck-Typing generisch
 * auf den passenden Code gemappt. Domain-Fehler OHNE `status` (z. B. ConvertError,
 * DeliveryNoteError) fallen auf 500 INTERNAL zurueck; Ressourcenrouten, die solche
 * Fehler werfen koennen, sollten sie explizit abfangen und als NotFoundError/
 * InvalidOperationError (oder mit eigenem `status`) weiterwerfen statt sich auf den
 * Fallback zu verlassen.
 */
import { z } from "zod";
import { NextResponse } from "next/server";
import { NotFoundError, InvalidOperationError } from "@/domain/errors";
import { ApiAuthError, ApiScopeError } from "@/domain/api-key/verify";
import { RateLimitError } from "@/lib/rate-limit";
import { IdempotencyConflictError, IdempotencyInProgressError } from "./idempotency";

export type ApiErrorCode = "VALIDATION" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "IDEMPOTENCY_MISMATCH" | "IDEMPOTENCY_IN_PROGRESS" | "INTERNAL";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

function statusToCode(status: number): ApiErrorCode | null {
  switch (status) {
    case 400:
      return "VALIDATION";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return null;
  }
}

/** Maps a caught error to an HTTP status + einheitlichen Fehlerkoerper. */
export function mapApiError(e: unknown): { status: number; body: ApiErrorBody } {
  if (e instanceof z.ZodError) {
    return { status: 400, body: { error: { code: "VALIDATION", message: "Validierung fehlgeschlagen.", details: { issues: e.issues } } } };
  }
  if (e instanceof ApiAuthError) {
    return { status: 401, body: { error: { code: "UNAUTHORIZED", message: e.message } } };
  }
  if (e instanceof ApiScopeError) {
    return { status: 403, body: { error: { code: "FORBIDDEN", message: e.message } } };
  }
  if (e instanceof IdempotencyConflictError) {
    return { status: 409, body: { error: { code: "IDEMPOTENCY_MISMATCH", message: e.message } } };
  }
  if (e instanceof IdempotencyInProgressError) {
    return { status: 409, body: { error: { code: "IDEMPOTENCY_IN_PROGRESS", message: e.message } } };
  }
  if (e instanceof NotFoundError) {
    return { status: 404, body: { error: { code: "NOT_FOUND", message: e.message } } };
  }
  if (e instanceof InvalidOperationError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message } } };
  }
  if (e instanceof RateLimitError) {
    return { status: 429, body: { error: { code: "RATE_LIMITED", message: e.message } } };
  }
  // Duck-Typing fuer bestehende Domain-Fehlerklassen mit `status` (z. B. DunningStageError).
  if (e instanceof Error && "status" in e && typeof (e as { status: unknown }).status === "number") {
    const status = (e as { status: number }).status;
    const code = statusToCode(status);
    if (code && status < 500) {
      return { status, body: { error: { code, message: e.message } } };
    }
  }
  console.error("[api] Unerwarteter Fehler:", e instanceof Error ? (e.stack ?? e.message) : e);
  return { status: 500, body: { error: { code: "INTERNAL", message: "Interner Fehler." } } };
}

export function apiError(e: unknown): NextResponse {
  const { status, body } = mapApiError(e);
  const res = NextResponse.json(body, { status });
  if (e instanceof RateLimitError) {
    res.headers.set("Retry-After", String(Math.ceil(e.retryAfterMs / 1000)));
  }
  return res;
}
