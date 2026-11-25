/**
 * Fehler-Mapping fuer /api/v1/* (Phase 10, Task 1, task-1-facts.md "Fehlerformat").
 * Einheitliches Format: `{ error: { code, message, details? } }`.
 *
 * Task 2 (task-2-facts.md, erster Punkt): explizite Registry der Domain-Fehlerklassen
 * OHNE eigene `status`-Eigenschaft → 409 CONFLICT mit dem Domain-Text. Klassen MIT
 * `status` (z. B. DunningStageError/DunningStageNotFoundError/DunningStageInUseError)
 * werden weiterhin ausschliesslich per Duck-Typing (weiter unten) behandelt — die
 * Duck-Typing-Pruefung laeuft VOR der Registry, damit z. B. DunningStageNotFoundError
 * (status 404) nicht durch die Registry auf 409 ueberschrieben wird.
 */
import { z } from "zod";
import { NextResponse } from "next/server";
import { NotFoundError, InvalidOperationError, EInvoiceInvalidError, ValidationError } from "@/domain/errors";
import { ApiAuthError, ApiScopeError } from "@/domain/api-key/verify";
import { RateLimitError } from "@/lib/rate-limit";
import { IdempotencyConflictError, IdempotencyInProgressError } from "./idempotency";
import { ConvertError } from "@/domain/document/convert";
import { PaymentError } from "@/domain/invoice/payment";
import { CreditError } from "@/domain/invoice/credit";
import { FinalizeError } from "@/domain/invoice/finalize";
import { CancelError } from "@/domain/invoice/cancel";
import { DunningError } from "@/domain/dunning/create";
import { PartialInvoiceError } from "@/domain/invoice/partial";
import { DownpaymentInvoiceError } from "@/domain/invoice/downpayment";
import { FinalInvoiceError } from "@/domain/invoice/final";
import { StatusTransitionError } from "@/domain/document/status";
import { ShareLinkError } from "@/domain/quote-share/link";
import { InvoiceUpdateError } from "@/domain/invoice/update";
import { DeliveryNoteError, DeliveryNoteValidationError, DeliveryNoteNotDraftError } from "@/domain/delivery-note/errors";
import { OverDeliveryError } from "@/domain/delivery-note/quantities";
import { RecurringError } from "@/domain/recurring/create";
import { RecurringMissedPeriodsError, RecurringTimingChangeError } from "@/domain/recurring/errors";
import { AttachmentValidationError } from "@/lib/attachments/storage";
import { PricingError } from "@/lib/pricing/errors";
import { MailNotConfiguredError } from "@/domain/email/settings";
import { TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import { VatCheckDisabledError, VatCheckRateLimitError } from "@/domain/customer/vat-check";
import { CustomerValidationError } from "@/domain/customer/save";
import { PortalError } from "@/domain/portal/errors";
import { OnlinePaymentError } from "@/domain/online-payment/errors";
import { PostalConflictError } from "@/domain/postal/errors";
import { PaymentRuleError } from "@/domain/payment-rule/errors";
import { PostalDisabledError, PostalKeyUnreadableError, PostalNotConfiguredError } from "@/domain/postal/settings";
import { LxpAuthError, LxpRequestError, LxpUnavailableError } from "@/lib/postal/letterxpress";
import { PostalNetworkForbiddenError } from "@/lib/postal/transport";
import { GrossDeviationError } from "@/domain/document/price-input";
import { UsageError, type UsageErrorCode } from "@/domain/recurring/usage-error";
import { DatevError, DatevExportError } from "@/domain/export/datev/errors";
import { describeError } from "@/lib/safe-error";

/**
 * Domain-Fehlerklassen (task-2-facts.md), die OHNE eigene `status`-Eigenschaft daherkommen
 * und daher deterministisch auf 409 CONFLICT gemappt werden — DunningStageError ist
 * absichtlich NICHT hier gelistet (hat `status` selbst, siehe Duck-Typing oben im Kommentar).
 */
const DOMAIN_CONFLICT_ERROR_CLASSES = [
  ConvertError,
  PaymentError,
  CreditError,
  FinalizeError,
  CancelError,
  DunningError,
  PartialInvoiceError,
  DownpaymentInvoiceError,
  FinalInvoiceError,
  StatusTransitionError,
  ShareLinkError,
  InvoiceUpdateError,
  DeliveryNoteNotDraftError,
  DeliveryNoteError,
  OverDeliveryError,
  RecurringError,
  AttachmentValidationError,
  PricingError,
  MailNotConfiguredError,
  TaxRateNotAllowedError,
  VatCheckDisabledError,
] as const;

/**
 * Fix-Welle (Should-fix 5): kein Request-Body-Limit bedeutete, dass ein einzelner
 * (z. B. 500 MB grosser) JSON-Body den Container-Prozess per OOM abschiessen konnte —
 * `req.text()` liest den kompletten Body in den Speicher, ohne jede Groessenpruefung
 * vorher. `withApi` (src/api/auth.ts) wirft diesen Fehler, wenn `Content-Length` das
 * Limit ueberschreitet ODER (falls der Header fehlt/falsch ist) der tatsaechlich
 * gelesene Body laenger ist.
 */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/** Falscher Content-Type bei Routen, die einen JSON-Body selbst lesen -> 415. */
export class UnsupportedMediaTypeError extends Error {
  constructor(message = "Content-Type muss application/json sein.") {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}

export type ApiErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNPROCESSABLE"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_MISMATCH"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "EINVOICE_INVALID"
  | "GROSS_DEVIATION"
  | "GROSS_DEVIATION_TOO_LARGE"
  | "GROSS_DISCOUNT_CONFLICT"
  | "INTERNAL";

export interface ApiErrorBody {
  error: {
    /** Bei Verbrauchsfehlern (422) der fachliche Code (z. B. NOT_USAGE_LINE, ALREADY_VOIDED). */
    code: ApiErrorCode | UsageErrorCode;
    message: string;
    details?: unknown;
    /** Nur 401: maschinenlesbarer Grund (MISSING | UNKNOWN | REVOKED | EXPIRED). */
    reason?: string;
    /** Nur 401 bei REVOKED/EXPIRED: Praefix des Schluessels (nie Hash/Token). */
    keyPrefix?: string;
    expiredAt?: string;
    revokedAt?: string;
  };
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
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE";
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
    return {
      status: 401,
      body: {
        error: {
          code: "UNAUTHORIZED",
          reason: e.reason,
          ...(e.keyPrefix !== undefined ? { keyPrefix: e.keyPrefix } : {}),
          ...(e.expiredAt ? { expiredAt: e.expiredAt.toISOString() } : {}),
          ...(e.revokedAt ? { revokedAt: e.revokedAt.toISOString() } : {}),
          message: e.message,
        },
      },
    };
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
  if (e instanceof PayloadTooLargeError) {
    return { status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE", message: e.message } } };
  }
  if (e instanceof UnsupportedMediaTypeError) {
    return { status: 415, body: { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: e.message } } };
  }
  // Fix-Runde 1 (Koordinator-Ruling c, Task 3): muss VOR dem generischen NotFoundError-
  // Zweig stehen (unabhaengige Klasse, keine Ueberschneidung, aber Reihenfolge analog den
  // uebrigen spezifischen Vorab-Pruefungen in dieser Funktion).
  if (e instanceof EInvoiceInvalidError) {
    return { status: 409, body: { error: { code: "EINVOICE_INVALID", message: e.message, details: { issues: e.issues } } } };
  }
  if (e instanceof GrossDeviationError) {
    return { status: 400, body: { error: { code: e.code, message: e.message } } };
  }
  // Phase 18f: Verbrauchserfassung. NOT_FOUND 404, CONFLICT 409, sonst 422 mit dem fachlichen Code.
  if (e instanceof UsageError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : 422;
    return { status, body: { error: { code: e.code, message: e.message } } };
  }
  if (e instanceof RecurringTimingChangeError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message, reason: "TIMING_CHANGE_UNACKNOWLEDGED", details: e.details } } };
  }
  if (e instanceof RecurringMissedPeriodsError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message, reason: e.code, details: { missedCount: e.missedCount } } } };
  }
  if (e instanceof ValidationError) {
    return { status: 400, body: { error: { code: "VALIDATION", message: e.message } } };
  }
  if (e instanceof NotFoundError) {
    return { status: 404, body: { error: { code: "NOT_FOUND", message: e.message } } };
  }
  if (e instanceof InvalidOperationError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message } } };
  }
  // Kundenportal: PORTAL_DISABLED / CUSTOMER_ARCHIVED als 409 mit fachlichem Code in `reason`.
  if (e instanceof PortalError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message, reason: e.code } } };
  }
  // Online-Zahlung: feste Texte, nie Anbietertexte. Unbekannte Rechnung 404, Fachfehler 422 mit Code in `reason`.
  if (e instanceof OnlinePaymentError) {
    if (e.code === "NOT_FOUND") return { status: 404, body: { error: { code: "NOT_FOUND", message: e.message } } };
    if (e.code === "RATE_LIMITED") return { status: 429, body: { error: { code: "RATE_LIMITED", message: e.message } } };
    return { status: 422, body: { error: { code: "UNPROCESSABLE", message: e.message, reason: e.code } } };
  }
  // Phase 16d: Postversand. Feste Texte, nie die Meldung des Anbieters (kein Schluessel in Antworten).
  if (e instanceof PostalConflictError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message, reason: e.code } } };
  }
  if (e instanceof PostalNotConfiguredError || e instanceof PostalDisabledError || e instanceof PostalKeyUnreadableError) {
    const reason = e instanceof PostalDisabledError ? "disabled" : e instanceof PostalNotConfiguredError ? "not_configured" : "key_unreadable";
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message, reason } } };
  }
  if (e instanceof PostalNetworkForbiddenError) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message, reason: "network_disabled" } } };
  }
  if (e instanceof LxpAuthError) {
    return { status: 502, body: { error: { code: "INTERNAL", message: "Der Briefdienst hat die Zugangsdaten abgelehnt.", reason: "provider_auth" } } };
  }
  if (e instanceof LxpRequestError) {
    return { status: 502, body: { error: { code: "INTERNAL", message: "Der Briefdienst hat die Anfrage abgelehnt.", reason: "provider_rejected" } } };
  }
  if (e instanceof LxpUnavailableError) {
    return { status: 502, body: { error: { code: "INTERNAL", message: "Der Briefdienst ist nicht erreichbar.", reason: "provider_unavailable" } } };
  }
  // Regeln nach Zahlungseingang: Fachfehler der Verwaltung (Limit, Referenzen, Wiederholen) als 422.
  if (e instanceof PaymentRuleError) {
    return { status: 422, body: { error: { code: "UNPROCESSABLE", message: e.message } } };
  }
  // DATEV-Export: fester fachlicher Code in `reason`, Liste fehlender Angaben in `details`.
  if (e instanceof DatevExportError) {
    const code: ApiErrorCode = e.status === 404 ? "NOT_FOUND" : e.status === 409 ? "CONFLICT" : e.status === 500 ? "INTERNAL" : "UNPROCESSABLE";
    const hasDetails = e.details.months !== undefined || e.details.issues !== undefined;
    return { status: e.status, body: { error: { code, message: e.message, reason: e.code, ...(hasDetails ? { details: e.details } : {}) } } };
  }
  if (e instanceof DatevError) {
    const status = e.code === "VALIDATION" ? 400 : e.code === "NOT_FOUND" ? 404 : e.code === "DEBTOR_LOCKED" || e.code === "DEBTOR_DUPLICATE" ? 409 : 422;
    const code: ApiErrorCode = status === 400 ? "VALIDATION" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "UNPROCESSABLE";
    return { status, body: { error: { code, message: e.message, reason: e.code } } };
  }
  if (e instanceof RateLimitError || e instanceof VatCheckRateLimitError) {
    return { status: 429, body: { error: { code: "RATE_LIMITED", message: e.message } } };
  }
  if (e instanceof CustomerValidationError) {
    return { status: 400, body: { error: { code: "VALIDATION", message: e.message } } };
  }
  // Duck-Typing fuer bestehende Domain-Fehlerklassen mit `status` (z. B. DunningStageError/
  // DunningStageNotFoundError/DunningStageInUseError — 400/404/409 je nach Unterklasse).
  if (e instanceof Error && "status" in e && typeof (e as { status: unknown }).status === "number") {
    const status = (e as { status: number }).status;
    const code = statusToCode(status);
    if (code && status < 500) {
      return { status, body: { error: { code, message: e.message } } };
    }
  }
  // DeliveryNoteValidationError extends DeliveryNoteError (siehe deren Modulkommentar:
  // "waehrend die generische DeliveryNoteError bei 409 bleibt") — MUSS vor dem generischen
  // DeliveryNoteError-Eintrag der Registry geprueft werden, sonst wuerde `instanceof
  // DeliveryNoteError` faelschlich auch fuer die Validierungs-Unterklasse 409 liefern.
  if (e instanceof DeliveryNoteValidationError) {
    return { status: 400, body: { error: { code: "VALIDATION", message: e.message } } };
  }
  // Task 2, task-2-facts.md (erster Punkt): explizite Registry der Domain-Fehlerklassen
  // OHNE `status` — deterministisch 409 CONFLICT statt 500-Fallback.
  if (e instanceof Error && DOMAIN_CONFLICT_ERROR_CLASSES.some((cls) => e instanceof cls)) {
    return { status: 409, body: { error: { code: "CONFLICT", message: e.message } } };
  }
  console.error("[api] Unerwarteter Fehler:", describeError(e));
  return { status: 500, body: { error: { code: "INTERNAL", message: "Interner Fehler." } } };
}

export function apiError(e: unknown): NextResponse {
  const { status, body } = mapApiError(e);
  const res = NextResponse.json(body, { status });
  if (e instanceof RateLimitError || e instanceof VatCheckRateLimitError) {
    res.headers.set("Retry-After", String(Math.ceil(e.retryAfterMs / 1000)));
  }
  return res;
}
