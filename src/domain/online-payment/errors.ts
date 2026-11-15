/**
 * Fehlerklassen der Online-Zahlung. Die Codes sind die stabile Schnittstelle fuer REST, MCP und UI.
 */
export type OnlinePaymentErrorCode =
  | "NOT_FOUND"
  | "NOT_PAYABLE"
  | "DIRECT_DEBIT"
  | "PREPAID"
  | "NONE"
  | "ACCOUNT_OFF"
  | "CURRENCY"
  | "INVOICE_STATE"
  | "LINK_CANCELLED"
  | "NO_KEY"
  | "NO_BASE_URL"
  | "NOT_TESTED"
  | "KEY_UNREADABLE"
  | "INVALID_KEY"
  | "RATE_LIMITED";

export class OnlinePaymentError extends Error {
  constructor(
    msg: string,
    readonly code: OnlinePaymentErrorCode,
  ) {
    super(msg);
    this.name = "OnlinePaymentError";
  }
}
