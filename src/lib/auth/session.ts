/**
 * Signiertes, zustandsloses Session-Token (HMAC-SHA256 via Web Crypto).
 * Web Crypto läuft sowohl in der Node-Runtime als auch in der Edge-Middleware.
 */
export const SESSION_COOKIE = "oig_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 Tage (Sekunden)
/** Phase 17d: Zwischen-Cookie zwischen Passwort und zweitem Faktor (5 Minuten). */
export const MFA_COOKIE = "oig_mfa";
export const MFA_MAX_AGE = 300;

function getSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  // Das feste Dev-Secret steht im Quellcode: in Produktion koennte jeder damit Sitzungen
  // faelschen. Deshalb dort kein Fallback, sondern harter Abbruch mit klarer Anweisung.
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET fehlt oder ist kuerzer als 16 Zeichen. Setzen (z. B. `openssl rand -base64 32`) und neu starten.");
  }
  return "dev-insecure-secret-bitte-AUTH_SECRET-setzen";
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/** Ergebnis von `verifySessionToken` bei einem gueltigen Token. */
export interface SessionTokenPayload {
  uid: string;
  /**
   * Task 9 (R12): Zeitstempel (epoch ms) von `User.passwordChangedAt` zum Ausstellungs-
   * zeitpunkt des Tokens, oder `null` (Konto hat sein Passwort noch nie geaendert). Nur
   * die Signatur/den Ablauf prueft diese Funktion selbst — der Abgleich gegen den
   * AKTUELLEN `User.passwordChangedAt`-Wert (Sitzungsentwertung nach Passwortwechsel)
   * passiert bewusst NICHT hier, sondern in `getCurrentUserId`/`userIdFromToken`
   * (`src/lib/auth/server.ts`). Fix-Welle 4 (must 2): `userIdFromToken` laeuft
   * mittlerweile SOWOHL im Root-Layout ALS AUCH direkt in `src/proxy.ts` — Next.js 16
   * fuehrt Proxy-Dateien immer in der Node.js-Laufzeit aus (kein optionales Edge mehr wie
   * beim frueheren `middleware.ts`), ein Datenbankzugriff dort ist also moeglich. Diese
   * Datei (`verifySessionToken`) bleibt trotzdem bewusst rein signatur-/ablaufpruefend
   * und ohne Datenbankzugriff, DAMIT sie unveraendert in beiden Kontexten wiederverwendbar
   * bleibt.
   */
  pwc: number | null;
}

export async function createSessionToken(userId: string, pwc: number | null = null): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_MAX_AGE * 1000, pwc })),
  );
  const sig = b64urlEncode(await hmac(payload));
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<SessionTokenPayload | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = b64urlEncode(await hmac(payload));
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;

  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { uid?: string; exp?: number; pwc?: number | null; typ?: string };
    // Phase 17d: Tokens mit `typ` (Zwischen-Token des zweiten Faktors) sind nie eine Sitzung.
    if (data.typ !== undefined) return null;
    if (!data.uid || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    // Alt-Token (vor Task 9 ausgestellt) tragen kein `pwc` — behandelt wie `null`
    // (Konto ohne Passwortwechsel), siehe SessionTokenPayload-Doc.
    return { uid: data.uid, pwc: typeof data.pwc === "number" ? data.pwc : null };
  } catch {
    return null;
  }
}

/**
 * Phase 17d: Zwischen-Token nach korrektem Passwort, vor dem zweiten Faktor. Eigene
 * HMAC-Domaene (Praefix `mfa.`) und Feld `typ: "mfa"` — Domaenentrennung verhindert, dass
 * ein Zwischen-Token als Sitzung gilt (und umgekehrt). `pwc` bindet das Token an den
 * Passwortstand: ein Passwortwechsel/-Reset entwertet laufende Zwischenschritte.
 */
export async function createPendingMfaToken(userId: string, pwc: number | null, nowMs: number = Date.now()): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ uid: userId, exp: nowMs + MFA_MAX_AGE * 1000, pwc, typ: "mfa" })),
  );
  const sig = b64urlEncode(await hmac(`mfa.${payload}`));
  return `${payload}.${sig}`;
}

export async function verifyPendingMfaToken(
  token: string | undefined | null,
  nowMs: number = Date.now(),
): Promise<{ uid: string; pwc: number | null } | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = b64urlEncode(await hmac(`mfa.${payload}`));
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;

  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { uid?: string; exp?: number; pwc?: number | null; typ?: string };
    if (data.typ !== "mfa") return null;
    if (!data.uid || typeof data.exp !== "number" || data.exp < nowMs) return null;
    return { uid: data.uid, pwc: typeof data.pwc === "number" ? data.pwc : null };
  } catch {
    return null;
  }
}
