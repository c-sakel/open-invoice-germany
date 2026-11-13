/**
 * Phase 16d — Fehlerklassen des Postversands (Domain). Die Codes sind die stabile Schnittstelle
 * fuer REST (HTTP 409), MCP und die Mahnautomatik.
 */
export type PostalConflictCode =
  | "ALREADY_SENT"
  | "PRICE_CHANGED"
  | "PRICE_UNAVAILABLE"
  | "PDF_CHANGED"
  | "BUDGET"
  | "NOT_CANCELLABLE"
  | "NO_ADDRESS"
  | "NOT_ALLOWED";

export class PostalConflictError extends Error {
  constructor(
    msg: string,
    readonly code: PostalConflictCode,
  ) {
    super(msg);
    this.name = "PostalConflictError";
  }
}
