/**
 * Passwort-Reset per Mail (Phase 17d).
 *
 * Sicherheitskern:
 * - Keine Konto-Aufzaehlung: `requestPasswordReset` liefert fuer bekannte, unbekannte,
 *   limitierte und nicht eingerichtete Faelle dasselbe Ergebnisformat; der Versand erfolgt
 *   durch den Aufrufer NACH der Antwort (`after()`), damit auch die Antwortzeit nichts verraet.
 * - Das Token (32 Byte, base64url) wird nur als SHA-256 gespeichert, gilt 30 Minuten und genau
 *   einmal (bedingtes `updateMany`, Erfolg nur bei `count === 1`); eine neue Anforderung
 *   entwertet offene Token.
 * - Der Link stammt ausschliesslich aus `APP_BASE_URL` (nie aus dem Host-Header).
 * - Einloesen setzt `passwordChangedAt` (alle Sitzungen enden) und hebt die Kontosperre auf.
 *   Bei aktiver 2FA ist zusaetzlich ein Code noetig (gleiche Sperr- und Orakel-Regeln wie
 *   `verifySecondFactor`: waehrend einer Sperre wird kein Code geprueft; falsche Codes zaehlen;
 *   ein falscher Code verbraucht das Token nicht).
 * - Weder Token, Passwort noch E-Mail-Adresse in Protokoll oder Log; kein EmailLog, kein CC/BCC.
 */
import { createHash, randomBytes } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { rateLimit } from "@/lib/rate-limit";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { createSmtpProvider } from "@/lib/mail/smtp";
import type { MailProvider } from "@/lib/mail/provider";
import { loadMailSettings } from "@/domain/email/settings";
import { DEFAULT_APP_NAME, loadBrand } from "@/domain/settings/brand";
import { instanceOrgId } from "@/domain/auth/instance";
import { lockState, logAccountEvent, registerFailedAttempt, voidResetTokens } from "@/domain/auth/attempts";
import { codeUserSelect, consumeSecondFactorCodeInTx, logRecoveryCodeUsed, peekSecondFactorCode } from "@/domain/auth/two-factor";
import { passwordResetConfirmSchema, passwordResetRequestSchema } from "@/schemas/auth";

export const RESET_TOKEN_TTL_MS = 30 * 60_000;
export const RESET_PER_ACCOUNT_PER_HOUR = 3;
export const RESET_IP_LIMIT = 5;
export const RESET_IP_WINDOW_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const CLEANUP_AGE_MS = 24 * HOUR_MS;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ResetAvailability = { available: true } | { available: false; reason: "org" | "smtp" | "base-url" };

export async function passwordResetAvailability(orgId?: string): Promise<ResetAvailability> {
  const id = orgId ?? (await instanceOrgId());
  if (!id) return { available: false, reason: "org" };
  const settings = await dbInternal.mailSettings.findUnique({ where: { orgId: id }, select: { orgId: true } });
  if (!settings) return { available: false, reason: "smtp" };
  if (!appBaseUrlFromEnv()) return { available: false, reason: "base-url" };
  return { available: true };
}

export interface ResetMail {
  orgId: string;
  to: string;
  subject: string;
  text: string;
}

/** `ipLimitChecked`: die Route hat die IP-Bremse bereits VOR der Antwort angewandt (nicht doppelt zaehlen). */
type RequestCtx = { ip?: string; now?: Date; orgId?: string; ipLimitChecked?: boolean };

/** IP-Bremse der Reset-Anforderung; wirft `RateLimitError`. Beruehrt keine Datenbank. */
export function enforceResetIpLimit(ip: string | undefined, now: Date = new Date()): void {
  rateLimit(`pw-reset:${ip ?? "unknown"}`, { limit: RESET_IP_LIMIT, windowMs: RESET_IP_WINDOW_MS, now: now.getTime() });
}

export async function requestPasswordReset(raw: unknown, ctx: RequestCtx = {}): Promise<{ mail: ResetMail | null }> {
  const input = passwordResetRequestSchema.parse(raw);
  const now = ctx.now ?? new Date();
  if (!ctx.ipLimitChecked) enforceResetIpLimit(ctx.ip, now);

  await dbInternal.passwordResetToken.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - CLEANUP_AGE_MS) } } });

  const orgId = ctx.orgId ?? (await instanceOrgId());
  const availability = await passwordResetAvailability(orgId ?? undefined);
  if (!orgId || !availability.available) {
    const reason = availability.available ? "org" : availability.reason;
    console.warn(`Passwort-Reset angefordert, aber nicht eingerichtet (${reason}) — kein Versand.`);
    return { mail: null };
  }
  const baseUrl = appBaseUrlFromEnv();
  if (!baseUrl) return { mail: null };

  const user = await dbInternal.user.findUnique({ where: { email: input.email }, select: { id: true, email: true } });
  if (!user) return { mail: null };

  const token = randomBytes(32).toString("base64url");
  // Zaehlen und Anlegen atomar: die erste Anweisung ist ein Schreibzugriff auf die User-Zeile.
  // Unter Postgres haelt sie die Zeilensperre bis zum Ende der Transaktion (parallele
  // Anforderungen desselben Kontos warten und zaehlen danach neu), unter SQLite
  // serialisiert sie die Schreibtransaktion.
  const created = await dbInternal.$transaction(async (tx) => {
    await tx.user.updateMany({ where: { id: user.id }, data: { email: user.email } });
    const recent = await tx.passwordResetToken.count({
      where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
    });
    if (recent >= RESET_PER_ACCOUNT_PER_HOUR) return false;
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashResetToken(token), createdAt: now, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) },
      select: { id: true },
    });
    return true;
  }).catch((e: unknown) => {
    // Laeuft im Hintergrund (after()): ein Datenbankfehler (z. B. Sperr-/Zeitueberschreitung bei
    // vielen parallelen Anforderungen) darf nicht durchschlagen — dann wird schlicht kein Token
    // ausgestellt (sicherer Ausfall, die Antwort an den Client ist ohnehin schon gesendet).
    console.warn("[password-reset] Anforderung nicht ausgestellt:", e instanceof Error ? e.message : e);
    return false;
  });
  if (!created) return { mail: null };
  await logAccountEvent(user.id, "PASSWORD_RESET_REQUESTED", ctx.ip, "Passwort-Reset angefordert", now);

  const brand = await loadBrand(orgId);
  const appName = brand.appName || DEFAULT_APP_NAME;
  const link = `${baseUrl}/login/passwort-zuruecksetzen/${token}`;
  const text = [
    "Hallo,",
    "",
    `für dein Konto bei ${appName} wurde ein neues Passwort angefordert. Über diesen Link kannst du es festlegen:`,
    "",
    link,
    "",
    "Der Link gilt 30 Minuten und lässt sich nur einmal verwenden. Ist die Zwei-Faktor-Anmeldung aktiv, brauchst du dafür zusätzlich einen Code aus deiner Authenticator-App oder einen Wiederherstellungscode.",
    "",
    "Wenn du das nicht angefordert hast, ignoriere diese E-Mail.",
  ].join("\n");
  return { mail: { orgId, to: user.email, subject: `Passwort zurücksetzen – ${appName}`, text } };
}

/** Versendet die Reset-Mail ueber das SMTP der Organisation; wirft nie (Fehler ohne Adresse/Token im Log). */
export async function deliverPasswordResetMail(mail: ResetMail, provider?: MailProvider): Promise<void> {
  try {
    const settings = await loadMailSettings(mail.orgId);
    if (!settings) return;
    const p = provider ?? createSmtpProvider(settings);
    await p.send({
      from: { name: settings.fromName, address: settings.fromEmail },
      to: [mail.to],
      cc: [],
      bcc: [],
      subject: mail.subject,
      text: mail.text,
      attachments: [],
    });
  } catch (e) {
    console.error("Passwort-Reset: Versand fehlgeschlagen:", e instanceof Error ? e.name : "Fehler");
  }
}

/** Ein Token, das nicht NACH der letzten Passwort-/2FA-Aenderung ausgestellt wurde, ist wertlos (Defense in Depth zu `voidResetTokens`). */
function issuedBeforePasswordChange(createdAt: Date, passwordChangedAt: Date | null): boolean {
  return passwordChangedAt !== null && createdAt.getTime() <= passwordChangedAt.getTime();
}

class CodeLostError extends Error {}

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export async function inspectResetToken(token: string, now: Date = new Date()): Promise<{ valid: false } | { valid: true; requiresSecondFactor: boolean }> {
  if (!TOKEN_FORMAT.test(token)) return { valid: false };
  const row = await dbInternal.passwordResetToken.findFirst({
    where: { tokenHash: hashResetToken(token), usedAt: null, expiresAt: { gt: now } },
    select: { createdAt: true, user: { select: { totpEnabledAt: true, passwordChangedAt: true } } },
  });
  if (!row || issuedBeforePasswordChange(row.createdAt, row.user.passwordChangedAt)) return { valid: false };
  return { valid: true, requiresSecondFactor: row.user.totpEnabledAt !== null };
}

export async function confirmPasswordReset(
  raw: unknown,
  ctx: { ip?: string; now?: Date } = {},
): Promise<
  | { status: "ok" }
  | { status: "invalid_token" }
  | { status: "second_factor_required" }
  | { status: "invalid_code" }
  | { status: "locked"; retryAfterMs: number }
> {
  const now = ctx.now ?? new Date();
  rateLimit(`pw-reset-confirm:${ctx.ip ?? "unknown"}`, { limit: RESET_IP_LIMIT, windowMs: RESET_IP_WINDOW_MS, now: now.getTime() });
  const input = passwordResetConfirmSchema.parse(raw);

  const row = await dbInternal.passwordResetToken.findFirst({
    where: { tokenHash: hashResetToken(input.token), usedAt: null, expiresAt: { gt: now } },
    select: {
      id: true,
      createdAt: true,
      user: { select: { ...codeUserSelect, failedLoginCount: true, lockedUntil: true, passwordChangedAt: true } },
    },
  });
  if (!row || issuedBeforePasswordChange(row.createdAt, row.user.passwordChangedAt)) return { status: "invalid_token" };
  const user = row.user;

  if (user.totpEnabledAt !== null) {
    if (!input.code) return { status: "second_factor_required" };
    const lock = lockState(user, now);
    // Waehrend der Sperre wird der Code nicht geprueft (kein Gueltigkeits-Orakel).
    if (lock.isLocked) return { status: "locked", retryAfterMs: lock.retryAfterMs };
    // Nur PRUEFEN; verbraucht wird der Code erst in der Transaktion, nachdem das Token
    // erfolgreich beansprucht wurde (ein verlorenes Rennen verbrennt keinen Code).
    if ((await peekSecondFactorCode(user.id, input.code, now)) === "invalid") {
      await registerFailedAttempt(user, { ip: ctx.ip, now }, "falscher Code (Passwort-Reset)");
      return { status: "invalid_code" };
    }
  }

  const passwordHash = hashPassword(input.newPassword);
  type Outcome = { status: "done"; usedRecovery: boolean } | { status: "token_lost" } | { status: "code_lost" };
  const outcome = await dbInternal.$transaction(async (tx): Promise<Outcome> => {
    // Zuerst das Token: wer das Rennen verliert, hat keinen Code verbraucht.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return { status: "token_lost" };
    let usedRecovery = false;
    if (user.totpEnabledAt !== null) {
      const consumed = await consumeSecondFactorCodeInTx(tx, user, input.code ?? "", now);
      // Code zwischenzeitlich anderweitig verbraucht: alles zurueck (auch der Token-Claim).
      if (consumed.status !== "ok") throw new CodeLostError();
      usedRecovery = consumed.usedRecovery;
    }
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
      select: { id: true },
    });
    await voidResetTokens(tx, user.id, now);
    return { status: "done", usedRecovery };
  }).catch((e: unknown): Outcome => {
    if (e instanceof CodeLostError) return { status: "code_lost" };
    throw e;
  });
  if (outcome.status === "token_lost") return { status: "invalid_token" };
  if (outcome.status === "code_lost") {
    await registerFailedAttempt(user, { ip: ctx.ip, now }, "falscher Code (Passwort-Reset)");
    return { status: "invalid_code" };
  }
  if (outcome.usedRecovery) await logRecoveryCodeUsed(user.id, ctx.ip, now);

  await logAccountEvent(user.id, "PASSWORD_RESET", ctx.ip, "Passwort zurueckgesetzt", now);
  return { status: "ok" };
}
