/**
 * Offene Freigabe-Sitzungen (TAN-Ablauf) im Prozess. Eine Sitzung gehoert genau einem Benutzer einer Firma und wird beim
 * Fortsetzen exklusiv entnommen; abgelaufene oder fremde Tokens sind nicht von unbekannten zu unterscheiden.
 */
import { randomBytes } from "node:crypto";
import type { FintsSession, ScaChallenge } from "@/lib/fints/client";
import { BankFetchError } from "./errors";
import type { RunSummary } from "./run-types";
import { releaseLease, type Lease } from "./lease";
import { FINTS_SCA_TIMEOUT_MS } from "./limits";

/** Was die Sitzung gerade erwartet (nur Verweise, keine Zugangsdaten; der PIN-HMAC dient der Banksperre-Pruefung). */
export interface PendingStep {
  kind: "sync" | "camt";
  pinHmac: string | null;
  accountId?: string;
  from?: string;
  to?: string;
  /** Stand eines manuellen Abrufs ueber mehrere Konten (nur Verweise und Zaehler). */
  fetch?: FetchProgress;
}

export interface FetchProgress {
  actorLabel: string;
  manualFrom?: string | undefined;
  /** Konten, die nach dem aktuellen noch folgen. */
  queue: string[];
  runs: RunSummary[];
  scaUsed: boolean;
  anySuccess: boolean;
  firstFailure: string | null;
}

export interface LiveSession {
  token: string;
  orgId: string;
  userId: string;
  connectionId: string;
  /** Besitzerkennung der Sperre des Bankzugangs; nur damit wird sie freigegeben. */
  lease: Lease;
  purpose: "SETUP" | "FETCH";
  session: FintsSession;
  challenge: ScaChallenge;
  createdAt: number;
  polls: number;
  nextPollAt: number;
  pending: PendingStep;
}

const MAX_SESSIONS = 50;

type Holder = { __oigFintsSessions?: Map<string, LiveSession> };

function registry(): Map<string, LiveSession> {
  const g = globalThis as Holder;
  if (!g.__oigFintsSessions) g.__oigFintsSessions = new Map();
  return g.__oigFintsSessions;
}

/** Legt die Sitzung ab; je Bankzugang nur eine gleichzeitig. */
export function putSession(s: Omit<LiveSession, "token">): string {
  const reg = registry();
  if (reg.size >= MAX_SESSIONS) throw new BankFetchError("BUSY");
  for (const v of reg.values()) if (v.connectionId === s.connectionId) throw new BankFetchError("BUSY");
  const token = randomBytes(16).toString("base64url");
  reg.set(token, { ...s, token });
  return token;
}

async function closeAndRelease(s: LiveSession): Promise<void> {
  try {
    await s.session.close();
  } catch {
    // close wirft nie, doppelt abgesichert
  }
  await releaseLease(s.orgId, s.connectionId, s.lease);
}

/** Entnimmt die Sitzung (nur gleiche Firma und gleicher Benutzer, nicht abgelaufen); sonst null. */
export function takeSession(token: string, orgId: string, userId: string, now: number = Date.now()): LiveSession | null {
  const reg = registry();
  const s = reg.get(token);
  if (!s || s.orgId !== orgId || s.userId !== userId) return null;
  reg.delete(token);
  if (now - s.createdAt > FINTS_SCA_TIMEOUT_MS) {
    void closeAndRelease(s);
    return null;
  }
  return s;
}

/** Gibt eine entnommene Sitzung unter demselben Token zurueck (Freigabe noch offen). */
export function returnSession(s: LiveSession): void {
  registry().set(s.token, s);
}

export async function dropSession(token: string): Promise<void> {
  const reg = registry();
  const s = reg.get(token);
  if (!s) return;
  reg.delete(token);
  await closeAndRelease(s);
}

/** Schliesst alle Sitzungen eines Bankzugangs (Archivieren, Aenderung der Zugangsdaten). */
export async function dropConnectionSessions(orgId: string, connectionId: string): Promise<void> {
  const reg = registry();
  for (const [token, s] of [...reg.entries()]) {
    if (s.orgId === orgId && s.connectionId === connectionId) {
      reg.delete(token);
      await closeAndRelease(s);
    }
  }
}

/** Schliesst abgelaufene Sitzungen (nach 5 Minuten). */
export async function sweepSessions(now: number = Date.now()): Promise<number> {
  const reg = registry();
  let n = 0;
  for (const [token, s] of [...reg.entries()]) {
    if (now - s.createdAt > FINTS_SCA_TIMEOUT_MS) {
      reg.delete(token);
      await closeAndRelease(s);
      n += 1;
    }
  }
  return n;
}

export function sessionCount(): number {
  return registry().size;
}
