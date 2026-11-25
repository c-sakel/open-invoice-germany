/**
 * Reine Form des Auto-Versand-Zustands (ohne Datenbank/Domain-Importe, damit Serialisierer keine Importzyklen bilden).
 */
import type { AutoSendStatus } from "./auto-send";

export interface AutoSendView {
  status: AutoSendStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Ausgabeform (REST/MCP): nur Status, Versuche, naechster Versuch, fester Fehlercode. */
export function publicAutoSend(v: AutoSendView | null): { status: AutoSendStatus; attempts: number; nextAttemptAt: string | null; lastError: string | null } | null {
  return v ? { status: v.status, attempts: v.attempts, nextAttemptAt: v.nextAttemptAt ? v.nextAttemptAt.toISOString() : null, lastError: v.lastError } : null;
}

