/**
 * Wiederherstellungscodes fuer den zweiten Faktor (Phase 17d): 10 Zeichen aus einem
 * 32er-Alphabet (50 Bit), Anzeige als "XXXXX-XXXXX". Gespeichert wird nur der HMAC
 * (HKDF-Schluessel aus AUTH_SECRET, eigener Zweck), nie der Code.
 */
import { randomBytes } from "node:crypto";
import { hmacWithDerivedKey } from "@/lib/crypto/secrets";

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_PURPOSE = "oig-recovery-code-v1";
/** 32 Zeichen, ohne 0/1/I/O. */
export const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LEN = 10;

function one(): string {
  const bytes = randomBytes(CODE_LEN);
  let s = "";
  // 256 % 32 = 0: kein Modulo-Bias.
  for (const b of bytes) s += RECOVERY_ALPHABET[b & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const set = new Set<string>();
  while (set.size < count) set.add(one());
  return [...set];
}

/** Leerzeichen/"-" raus, Grossbuchstaben; genau 10 Alphabetzeichen, sonst `null`. */
export function normalizeRecoveryCode(input: string): string | null {
  const n = input.replace(/[\s-]/g, "").toUpperCase();
  if (n.length !== CODE_LEN) return null;
  for (const ch of n) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return n;
}

export function hashRecoveryCode(normalized: string): string {
  return hmacWithDerivedKey(normalized, RECOVERY_CODE_PURPOSE);
}
