/** Fehler der Verbrauchserfassung (Phase 18f); der Code steuert die Abbildung auf HTTP/MCP. */
export type UsageErrorCode =
  | "NOT_FOUND"
  | "NOT_ACTIVE"
  | "NOT_USAGE_LINE"
  | "PERIOD_BILLED"
  | "AFTER_END"
  | "IN_FUTURE"
  | "ALREADY_BILLED"
  | "ALREADY_VOIDED"
  | "CONFLICT";

export class UsageError extends Error {
  constructor(
    public readonly code: UsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}
