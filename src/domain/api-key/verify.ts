/**
 * Verifikation eines Bearer-Tokens gegen den gespeicherten API-Schluessel
 * (Phase 10, Task 1). Genutzt von src/api/auth.ts (withApi-Wrapper).
 */
import { dbInternal } from "@/lib/db";
import type { ApiKeyScope } from "@/schemas";
import { hashApiToken } from "./create";

/** Maschinenlesbarer Grund einer 401-Antwort (Body `error.reason`). */
export type ApiAuthReason = "MISSING" | "UNKNOWN" | "REVOKED" | "EXPIRED";

export interface ApiAuthErrorDetails {
  reason: ApiAuthReason;
  /** Nur bei REVOKED/EXPIRED: Feld `prefix` der Schluesselzeile (nie Hash/Token). */
  keyPrefix?: string;
  expiredAt?: Date;
  revokedAt?: Date;
}

export class ApiAuthError extends Error {
  readonly reason: ApiAuthReason;
  readonly keyPrefix?: string;
  readonly expiredAt?: Date;
  readonly revokedAt?: Date;
  constructor(message: string, details: ApiAuthErrorDetails) {
    super(message);
    this.name = "ApiAuthError";
    this.reason = details.reason;
    this.keyPrefix = details.keyPrefix;
    this.expiredAt = details.expiredAt;
    this.revokedAt = details.revokedAt;
  }
}

export class ApiScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiScopeError";
  }
}

export interface VerifiedApiKey {
  id: string;
  orgId: string;
  name: string;
  scopes: ApiKeyScope[];
  /** Ablaufzeitpunkt, falls gesetzt (-> Antwort-Header X-Api-Key-Expires-At). */
  expiresAt: Date | null;
}

function parseScopes(scopesJson: string): ApiKeyScope[] {
  return scopesJson.split(",").filter(Boolean) as ApiKeyScope[];
}

// Fix-Runde 1 S2: lastUsedAt nur schreiben, wenn NULL oder aelter als dieses Fenster —
// sonst ein DB-Write bei JEDER einzelnen API-Anfrage (unnoetige Last bei hoher Frequenz,
// Wert wird ohnehin nur grob/"zuletzt aktiv" angezeigt, keine Praezision noetig).
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Prueft ein Bearer-Token: bekannt, nicht widerrufen, nicht abgelaufen. Aktualisiert
 * bei Erfolg `lastUsedAt` — gedrosselt (Fix-Runde 1 S2): nur wenn NULL oder aelter
 * als LAST_USED_THROTTLE_MS, kein Write bei jeder einzelnen Anfrage. Wirft
 * ApiAuthError (401) bei jedem Fehlschlag — der Text
 * unterscheidet bewusst NICHT zwischen "unbekannt"/"widerrufen"/"abgelaufen" nach
 * aussen relevant (alle 401), traegt die Unterscheidung aber im Fehlertext fuer Logs/Tests.
 */
export async function verifyApiToken(token: string | undefined | null): Promise<VerifiedApiKey> {
  if (!token || !token.startsWith("oig_")) {
    throw new ApiAuthError("Kein gueltiger API-Schluessel im Authorization-Header.", { reason: "MISSING" });
  }
  const hash = hashApiToken(token);
  const row = await dbInternal.apiKey.findUnique({ where: { keyHash: hash } });
  if (!row) throw new ApiAuthError("Unbekannter API-Schluessel.", { reason: "UNKNOWN" });
  if (row.revokedAt) throw new ApiAuthError("API-Schluessel wurde widerrufen.", { reason: "REVOKED", keyPrefix: row.prefix, revokedAt: row.revokedAt });
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new ApiAuthError("API-Schluessel ist abgelaufen.", { reason: "EXPIRED", keyPrefix: row.prefix, expiredAt: row.expiresAt });
  }
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await dbInternal.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } });
  }
  return { id: row.id, orgId: row.orgId, name: row.name, scopes: parseScopes(row.scopesJson), expiresAt: row.expiresAt };
}

/** Wirft ApiScopeError (403), wenn der Schluessel den geforderten Scope nicht traegt. */
export function requireScope(key: VerifiedApiKey, scope: ApiKeyScope): void {
  if (!key.scopes.includes(scope)) {
    throw new ApiScopeError(`API-Schluessel "${key.name}" hat nicht den erforderlichen Scope "${scope}".`);
  }
}
