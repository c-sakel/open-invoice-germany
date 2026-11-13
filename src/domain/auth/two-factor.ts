/**
 * Zwei-Faktor-Anmeldung (TOTP, Phase 17d): einrichten, abschalten, Wiederherstellungscodes
 * erneuern und zweiter Faktor bei der Anmeldung.
 *
 * Sicherheitskern:
 * - Das TOTP-Geheimnis liegt nur verschluesselt in der DB (`encryptSecret`, eigener Zweck);
 *   Wiederherstellungscodes nur als HMAC.
 * - Jeder TOTP-Schritt und jeder Wiederherstellungscode gilt GENAU EINMAL: die Verbrauchs-
 *   markierung ist ein bedingtes `updateMany` (Compare-and-set), Erfolg nur bei `count === 1`
 *   — auch bei zwei gleichzeitigen Einreichungen desselben Codes.
 * - Falsche Codes zaehlen wie falsche Passwoerter auf IP-Bremse (`login:<ip>`) und
 *   Kontosperre (`attempts.ts`); ein richtiges Passwort allein setzt den Zaehler bei aktiver
 *   2FA nicht zurueck (siehe `login.ts`).
 * - Waehrend einer aktiven Sperre wird ein Code weder geprueft noch verbraucht (einheitlich `locked`).
 * - Codevergleiche zeitkonstant (`totp.ts`: `timingSafeEqual`; Wiederherstellungscodes:
 *   Vergleich ueber den HMAC in der DB).
 * - Datenbankzugriffe innerhalb von `$transaction` ausschliesslich ueber `tx`.
 * - Einschalten, Abschalten und Erneuern der Wiederherstellungscodes beenden alle ANDEREN
 *   Sitzungen: sie setzen `User.passwordChangedAt` (derselbe Mechanismus wie die Passwortaenderung,
 *   `userIdFromToken` vergleicht `pwc`); die aufrufende Route stellt danach das Cookie des eigenen
 *   Browsers per `setSession` neu aus. Bewusst KEIN eigenes Feld: dadurch entfaellt eine Migration
 *   (SQLite + Postgres), und auch ein laufender Zwischenschritt `oig_mfa` (gleiches `pwc`) verfaellt.
 */
import QRCode from "qrcode";
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, otpauthUri } from "@/lib/auth/totp";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from "@/lib/auth/recovery-codes";
import { logActivity } from "@/domain/activity/log";
import { DEFAULT_APP_NAME, loadBrand } from "@/domain/settings/brand";
import { IP_RATE_LIMIT, IP_RATE_WINDOW_MS, clearAttempts, lockState, logAccountEvent, registerFailedAttempt, voidResetTokens } from "@/domain/auth/attempts";
import { instanceOrgId } from "@/domain/auth/instance";
import { secondFactorSchema, totpConfirmSchema, totpEnableSchema } from "@/schemas/auth";

export const TOTP_SECRET_PURPOSE = "oig-totp-v1";

export class TotpAlreadyEnabledError extends Error {
  constructor() {
    super("Die Zwei-Faktor-Anmeldung ist bereits aktiv.");
    this.name = "TotpAlreadyEnabledError";
  }
}

type Ctx = { ip?: string; now?: Date };

async function issuerName(): Promise<string> {
  const orgId = await instanceOrgId();
  if (!orgId) return DEFAULT_APP_NAME;
  const brand = await loadBrand(orgId);
  return brand.appName || DEFAULT_APP_NAME;
}

/** Entschluesselt das Geheimnis; bei Fehler (z. B. AUTH_SECRET gewechselt) `null` — wie ein falscher Code. */
function readSecret(enc: string): Buffer | null {
  try {
    return base32Decode(decryptSecret(enc, TOTP_SECRET_PURPOSE));
  } catch {
    console.warn("two-factor: TOTP-Geheimnis nicht lesbar (AUTH_SECRET geaendert?)");
    return null;
  }
}

export async function beginTotpSetup(userId: string, ctx: { issuer?: string } = {}): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string }> {
  const user = await dbInternal.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabledAt: true } });
  if (!user) throw new Error("Konto nicht gefunden.");
  if (user.totpEnabledAt !== null) throw new TotpAlreadyEnabledError();

  const raw = generateTotpSecret();
  const secret = base32Encode(raw);
  const enc = encryptSecret(secret, TOTP_SECRET_PURPOSE);
  // Bedingt: eine zwischenzeitlich aktivierte 2FA wird nie ueberschrieben.
  const res = await dbInternal.user.updateMany({
    where: { id: userId, totpEnabledAt: null },
    data: { totpSecretEnc: enc, totpLastStep: null },
  });
  if (res.count !== 1) throw new TotpAlreadyEnabledError();

  const uri = otpauthUri({ secret: raw, account: user.email, issuer: ctx.issuer ?? (await issuerName()) });
  const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
  return { secret, otpauthUri: uri, qrDataUrl };
}

/**
 * Aktiviert die 2FA. Re-Auth: neben dem Code aus der App ist das AKTUELLE Passwort Pflicht
 * (eine entfuehrte Sitzung darf den Inhaber nicht aussperren). Falsches Passwort zaehlt wie bei
 * der Passwortaenderung als Fehlversuch (Kontosperre) und auf die IP-Bremse `password-change:<ip>`.
 */
export async function enableTotp(
  userId: string,
  raw: unknown,
  ctx: { ip?: string; now?: Date } = {},
): Promise<
  | { status: "ok"; recoveryCodes: string[] }
  | { status: "invalid_code" }
  | { status: "invalid_password" }
  | { status: "locked"; retryAfterMs: number }
  | { status: "no_pending_setup" }
> {
  const now = ctx.now ?? new Date();
  rateLimit(`password-change:${ctx.ip ?? "unknown"}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });
  const parsed = totpEnableSchema.safeParse(raw);
  const user = await dbInternal.user.findUnique({
    where: { id: userId },
    select: { totpSecretEnc: true, totpEnabledAt: true, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });
  if (!user) return { status: "no_pending_setup" };
  if (user.totpEnabledAt !== null) throw new TotpAlreadyEnabledError();
  if (!user.totpSecretEnc) return { status: "no_pending_setup" };
  if (!parsed.success) return { status: "invalid_code" };

  const lock = lockState({ id: userId, ...user }, now);
  if (!verifyPassword(parsed.data.password, user.passwordHash)) {
    await registerFailedAttempt({ id: userId, ...user }, { ip: ctx.ip, now }, "falsches Passwort (2FA einrichten)");
    return { status: "invalid_password" };
  }
  if (lock.isLocked) return { status: "locked", retryAfterMs: lock.retryAfterMs };

  const secret = readSecret(user.totpSecretEnc);
  if (!secret) return { status: "invalid_code" };
  const step = matchTotp(secret, parsed.data.code, now);
  if (step === null) return { status: "invalid_code" };

  const recoveryCodes = generateRecoveryCodes();
  const activated = await dbInternal.$transaction(async (tx) => {
    // Bedingt gegen Doppel-Aktivierung und gegen ein zwischenzeitlich ersetztes Geheimnis.
    const res = await tx.user.updateMany({
      where: { id: userId, totpEnabledAt: null, totpSecretEnc: user.totpSecretEnc },
      data: { totpEnabledAt: now, totpLastStep: step, passwordChangedAt: now },
    });
    if (res.count !== 1) return false;
    await voidResetTokens(tx, userId, now);
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!) })) });
    return true;
  });
  if (!activated) return { status: "no_pending_setup" };

  await logAccountEvent(userId, "TOTP_ENABLED", undefined, "Zwei-Faktor-Anmeldung eingerichtet", now);
  return { status: "ok", recoveryCodes };
}

type CodeUser = { id: string; totpEnabledAt: Date | null; totpSecretEnc: string | null; totpLastStep: number | null };

/** Ziffern (ggf. mit Leerzeichen) = TOTP, sonst Wiederherstellungscode. */
function classify(input: string): { kind: "totp"; code: string } | { kind: "recovery"; normalized: string } | { kind: "none" } {
  const digits = input.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) return { kind: "totp", code: digits };
  const normalized = normalizeRecoveryCode(input);
  return normalized ? { kind: "recovery", normalized } : { kind: "none" };
}

type Db = Prisma.TransactionClient | typeof dbInternal;

/** TOTP-Schritt per CAS verbrauchen (nur ein groesserer Schritt als der letzte gilt). */
async function claimTotpStep(db: Db, userId: string, step: number): Promise<boolean> {
  const res = await db.user.updateMany({
    where: { id: userId, totpEnabledAt: { not: null }, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return res.count === 1;
}

async function claimRecoveryCode(db: Db, userId: string, codeHash: string, now: Date): Promise<boolean> {
  const res = await db.recoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: now } });
  return res.count === 1;
}

export async function logRecoveryCodeUsed(userId: string, ip: string | undefined, now: Date): Promise<void> {
  const remaining = await dbInternal.recoveryCode.count({ where: { userId, usedAt: null } });
  const orgId = await instanceOrgId();
  if (orgId) {
    await logActivity(dbInternal, {
      orgId,
      entityType: "USER",
      entityId: userId,
      type: "RECOVERY_CODE_USED",
      actor: userId,
      at: now,
      data: { ip: ip ?? null, remaining },
    });
  }
}

/** Prueft den Code; mit `consume` wird Schritt bzw. Wiederherstellungscode per CAS verbraucht. */
async function evaluateCode(user: CodeUser, input: string, now: Date, consume: boolean, ip: string | undefined): Promise<"ok" | "invalid"> {
  if (user.totpEnabledAt === null) return "invalid";
  const c = classify(input);
  if (c.kind === "totp") {
    if (!user.totpSecretEnc) return "invalid";
    const secret = readSecret(user.totpSecretEnc);
    if (!secret) return "invalid";
    const step = matchTotp(secret, c.code, now, { lastStep: user.totpLastStep });
    if (step === null) return "invalid";
    if (!consume) return "ok";
    return (await claimTotpStep(dbInternal, user.id, step)) ? "ok" : "invalid";
  }
  if (c.kind === "recovery") {
    const codeHash = hashRecoveryCode(c.normalized);
    if (!consume) {
      const found = await dbInternal.recoveryCode.findFirst({ where: { userId: user.id, codeHash, usedAt: null }, select: { id: true } });
      return found ? "ok" : "invalid";
    }
    if (!(await claimRecoveryCode(dbInternal, user.id, codeHash, now))) return "invalid";
    await logRecoveryCodeUsed(user.id, ip, now);
    return "ok";
  }
  return "invalid";
}

/**
 * Verbraucht den Code INNERHALB einer laufenden Transaktion (Reset: Token-Claim und Code
 * gehoeren zusammen; verliert der Aufrufer das Token-Rennen, bleibt der Code unberuehrt).
 * Das Protokoll fuer einen Wiederherstellungscode schreibt der Aufrufer NACH dem Commit
 * (`logRecoveryCodeUsed`).
 */
export async function consumeSecondFactorCodeInTx(
  tx: Prisma.TransactionClient,
  user: CodeUser,
  input: string,
  now: Date,
): Promise<{ status: "ok"; usedRecovery: boolean } | { status: "invalid" }> {
  if (user.totpEnabledAt === null) return { status: "invalid" };
  const c = classify(input);
  if (c.kind === "totp") {
    if (!user.totpSecretEnc) return { status: "invalid" };
    const secret = readSecret(user.totpSecretEnc);
    if (!secret) return { status: "invalid" };
    const step = matchTotp(secret, c.code, now, { lastStep: user.totpLastStep });
    if (step === null || !(await claimTotpStep(tx, user.id, step))) return { status: "invalid" };
    return { status: "ok", usedRecovery: false };
  }
  if (c.kind === "recovery") {
    if (!(await claimRecoveryCode(tx, user.id, hashRecoveryCode(c.normalized), now))) return { status: "invalid" };
    return { status: "ok", usedRecovery: true };
  }
  return { status: "invalid" };
}

/** Prueft den Code OHNE ihn zu verbrauchen (fuer den Reset, der ihn spaeter in der Transaktion verbraucht). */
export async function peekSecondFactorCode(userId: string, code: string, now: Date): Promise<"ok" | "invalid"> {
  const user = await dbInternal.user.findUnique({ where: { id: userId }, select: codeUserSelect });
  if (!user) return "invalid";
  return evaluateCode(user, code, now, false, undefined);
}

export type { CodeUser };

export const codeUserSelect = { id: true, totpEnabledAt: true, totpSecretEnc: true, totpLastStep: true } as const;

/** Verbraucht einen TOTP-Code oder Wiederherstellungscode (ohne Fehlversuchszaehlung; fuer Reset, T5). */
export async function checkSecondFactorCode(userId: string, code: string, now: Date, ctx: { ip?: string } = {}): Promise<"ok" | "invalid"> {
  const user = await dbInternal.user.findUnique({ where: { id: userId }, select: codeUserSelect });
  if (!user) return "invalid";
  return evaluateCode(user, code, now, true, ctx.ip);
}

export async function verifySecondFactor(
  pending: { uid: string; pwc: number | null },
  raw: unknown,
  ctx: Ctx = {},
): Promise<{ status: "ok"; userId: string } | { status: "invalid" } | { status: "locked"; retryAfterMs: number } | { status: "expired" }> {
  const input = secondFactorSchema.parse(raw);
  const now = ctx.now ?? new Date();
  // Gemeinsamer Bucket mit der Passwortanmeldung.
  rateLimit(`login:${ctx.ip ?? "unknown"}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });

  const user = await dbInternal.user.findUnique({
    where: { id: pending.uid },
    select: { ...codeUserSelect, passwordChangedAt: true, failedLoginCount: true, lockedUntil: true },
  });
  if (!user || user.totpEnabledAt === null || (user.passwordChangedAt?.getTime() ?? null) !== pending.pwc) return { status: "expired" };

  const lock = lockState(user, now);
  if (lock.isLocked) {
    // Waehrend der Sperre wird der Code NICHT geprueft: richtig und falsch liefern dieselbe
    // Antwort (kein Gueltigkeits-Orakel, auch nicht ueber Wiederherstellungscodes oder Antwortzeit).
    return { status: "locked", retryAfterMs: lock.retryAfterMs };
  }

  const result = await evaluateCode(user, input.code, now, true, ctx.ip);
  if (result === "invalid") {
    await registerFailedAttempt(user, { ip: ctx.ip, now }, "falscher Code (zweiter Faktor)");
    return { status: "invalid" };
  }
  await clearAttempts(user.id, now, { lastLogin: true });
  return { status: "ok", userId: user.id };
}

type ConfirmResult = { status: "ok" } | { status: "invalid" } | { status: "locked"; retryAfterMs: number };

/** Passwort UND zweiter Faktor; falsche Eingaben zaehlen als Fehlversuch. */
async function confirmPasswordAndCode(userId: string, raw: unknown, ctx: Ctx, now: Date): Promise<ConfirmResult> {
  const input = totpConfirmSchema.parse(raw);
  // Gleiche IP-Bremse wie die Passwortaenderung (Namensraum geteilt).
  rateLimit(`password-change:${ctx.ip ?? "unknown"}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });
  const user = await dbInternal.user.findUnique({
    where: { id: userId },
    select: { ...codeUserSelect, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });
  if (!user || user.totpEnabledAt === null) return { status: "invalid" };

  const lock = lockState(user, now);
  const passwordOk = verifyPassword(input.password, user.passwordHash);
  if (!passwordOk) {
    await registerFailedAttempt(user, { ip: ctx.ip, now }, "falsches Passwort (Zwei-Faktor-Verwaltung)");
    return { status: "invalid" };
  }
  if (lock.isLocked) return { status: "locked", retryAfterMs: lock.retryAfterMs };

  const code = await evaluateCode(user, input.code, now, true, ctx.ip);
  if (code === "invalid") {
    await registerFailedAttempt(user, { ip: ctx.ip, now }, "falscher Code (Zwei-Faktor-Verwaltung)");
    return { status: "invalid" };
  }
  await clearAttempts(user.id, now);
  return { status: "ok" };
}

export async function disableTotp(userId: string, raw: unknown, ctx: Ctx = {}): Promise<ConfirmResult> {
  const now = ctx.now ?? new Date();
  const res = await confirmPasswordAndCode(userId, raw, ctx, now);
  if (res.status !== "ok") return res;
  await dbInternal.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, passwordChangedAt: now }, select: { id: true } });
    await voidResetTokens(tx, userId, now);
    await tx.recoveryCode.deleteMany({ where: { userId } });
  });
  await logAccountEvent(userId, "TOTP_DISABLED", ctx.ip, "Zwei-Faktor-Anmeldung abgeschaltet", now);
  return { status: "ok" };
}

export async function renewRecoveryCodes(
  userId: string,
  raw: unknown,
  ctx: Ctx = {},
): Promise<{ status: "ok"; recoveryCodes: string[] } | { status: "invalid" } | { status: "locked"; retryAfterMs: number }> {
  const now = ctx.now ?? new Date();
  const res = await confirmPasswordAndCode(userId, raw, ctx, now);
  if (res.status !== "ok") return res;
  const recoveryCodes = generateRecoveryCodes();
  await dbInternal.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordChangedAt: now }, select: { id: true } });
    await voidResetTokens(tx, userId, now);
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!) })) });
  });
  await logAccountEvent(userId, "RECOVERY_CODES_RENEWED", ctx.ip, "Wiederherstellungscodes erneuert", now);
  return { status: "ok", recoveryCodes };
}

export async function accountSecurityStatus(userId: string): Promise<{ totpEnabledAt: Date | null; recoveryCodesRemaining: number }> {
  const user = await dbInternal.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  const recoveryCodesRemaining = await dbInternal.recoveryCode.count({ where: { userId, usedAt: null } });
  return { totpEnabledAt: user?.totpEnabledAt ?? null, recoveryCodesRemaining };
}
