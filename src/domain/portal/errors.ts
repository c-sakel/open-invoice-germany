/**
 * Fehlerklassen des Kundenportals. Die Codes sind die stabile Schnittstelle fuer REST, MCP und UI.
 */
export type PortalErrorCode = "PORTAL_DISABLED" | "CUSTOMER_ARCHIVED" | "NO_RECIPIENT" | "NO_ACTIVE_LINK";

export class PortalError extends Error {
  constructor(
    msg: string,
    readonly code: PortalErrorCode,
  ) {
    super(msg);
    this.name = "PortalError";
  }
}
