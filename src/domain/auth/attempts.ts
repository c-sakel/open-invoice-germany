/**
 * Fehlversuche und Kontosperre (Phase 14a Task 8, Fix-Wellen 3/4; Phase 17d aus `login.ts`
 * herausgeloest, damit Passwort UND zweiter Faktor dieselbe Logik teilen).
 *
 * Ruling (Betreiber-Vorgabe): der Betreiber darf sich nicht dauerhaft selbst aussperren
 * koennen. Zaehler UND Sperre bleiben eingefroren, solange eine Sperre aktiv ist
 * (`lockState().isLocked`) — weitere Fehlversuche WAEHREND einer laufenden Sperre
 * verlaengern sie nicht und erzeugen keinen weiteren Log-Eintrag (sonst unbegrenztes
 * ActivityLog-Wachstum bei andauerndem Angriff; die Sperre selbst wird beim Ausloesen als
 * `LOGIN_LOCKED` protokolliert). Jede Sperre hat damit eine feste Obergrenze von
 * `LOCK_DURATION_MS`. Eine ABGELAUFENE Sperre (`expiredLock`) laesst den Zaehler nicht auf
 * dem Schwellenwert stehen: der naechste Fehlversuch zaehlt wie der ERSTE einer neuen
 * Serie (Fix-Welle 4), sonst sperrte ein einziger Fehlversuch je Sperrfenster erneut.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { logActivity, type ActivityType } from "@/domain/activity/log";
import { instanceOrgId } from "@/domain/auth/instance";

export const LOCK_THRESHOLD = 5;
export const LOCK_DURATION_MS = 15 * 60_000;
export const IP_RATE_LIMIT = 10;
export const IP_RATE_WINDOW_MS = 5 * 60_000;

/** Platzhalter-"Konto-ID" fuer Protokolleintraege zu einer UNBEKANNTEN E-Mail-Adresse
 *  (Fix-Welle 3, Laufzeit-Leak) — kein echtes `User.id` (cuid), die Adresse selbst kommt
 *  nie ins Protokoll (R12). */
export const UNKNOWN_ACCOUNT_ID = "unknown";

export type AttemptUser = { id: string; failedLoginCount: number; lockedUntil: Date | null };

export type AccountEventType = Extract<
  ActivityType,
  | "LOGIN_FAILED"
  | "LOGIN_LOCKED"
  | "PASSWORD_CHANGED"
  | "TOTP_ENABLED"
  | "TOTP_DISABLED"
  | "RECOVERY_CODES_RENEWED"
  | "RECOVERY_CODE_USED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET"
>;

export function lockState(u: AttemptUser, now: Date): { isLocked: boolean; expiredLock: boolean; retryAfterMs: number } {
  const isLocked = u.lockedUntil !== null && u.lockedUntil.getTime() > now.getTime();
  const expiredLock = u.lockedUntil !== null && !isLocked;
  return { isLocked, expiredLock, retryAfterMs: isLocked ? u.lockedUntil!.getTime() - now.getTime() : 0 };
}

/** Schreibt einen Konto-Ereigniseintrag — NIE E-Mail, Passwort, Code oder Geheimnis in `data` (R12). */
export async function logAccountEvent(
  userId: string,
  type: AccountEventType,
  ip: string | undefined,
  reason: string,
  now: Date,
  extra: Record<string, number | string | null> = {},
): Promise<void> {
  const orgId = await instanceOrgId();
  if (!orgId) return; // Erstinstallation ohne Organisation.
  await logActivity(dbInternal, { orgId, entityType: "USER", entityId: userId, type, actor: userId, at: now, data: { ip: ip ?? null, reason, ...extra } });
}

/**
 * Zaehlt einen Fehlversuch (Passwort ODER zweiter Faktor); waehrend aktiver Sperre ein No-op.
 *
 * Atomar (parallele Fehlversuche duerfen keine Zaehlung verlieren): der Zaehler wird in der DB
 * bedingt hochgezaehlt (nie ueber den Schwellenwert, nie bei aktiver Sperre), die Sperre aus dem
 * aktuellen DB-Wert gesetzt (bedingtes Update `failedLoginCount >= LOCK_THRESHOLD`). Eine
 * abgelaufene Sperre wird per Compare-and-set genau einmal auf 1 zurueckgesetzt; wer den
 * Wettlauf verliert, zaehlt normal weiter.
 */
export async function registerFailedAttempt(u: AttemptUser, ctx: { ip?: string; now: Date }, reason: string): Promise<void> {
  const { now } = ctx;
  const { isLocked, expiredLock } = lockState(u, now);
  if (isLocked) return;

  if (expiredLock) {
    const reset = await dbInternal.user.updateMany({
      where: { id: u.id, lockedUntil: u.lockedUntil },
      data: { failedLoginCount: 1, lockedUntil: null },
    });
    if (reset.count === 1) {
      await logAccountEvent(u.id, "LOGIN_FAILED", ctx.ip, reason, now);
      return;
    }
  }

  const notLocked = [{ lockedUntil: null }, { lockedUntil: { lte: now } }];
  const inc = await dbInternal.user.updateMany({
    where: { id: u.id, failedLoginCount: { lt: LOCK_THRESHOLD }, OR: notLocked },
    data: { failedLoginCount: { increment: 1 } },
  });
  const fresh = await dbInternal.user.findUnique({ where: { id: u.id }, select: { failedLoginCount: true, lockedUntil: true } });
  if (!fresh) return;
  if (inc.count === 1) await logAccountEvent(u.id, "LOGIN_FAILED", ctx.ip, reason, now);

  if (fresh.failedLoginCount >= LOCK_THRESHOLD) {
    const lock = await dbInternal.user.updateMany({
      where: { id: u.id, failedLoginCount: { gte: LOCK_THRESHOLD }, OR: notLocked },
      data: { lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS) },
    });
    if (lock.count === 1) await logAccountEvent(u.id, "LOGIN_LOCKED", ctx.ip, `${fresh.failedLoginCount} Fehlversuche in Folge`, now);
  }
}

/** Setzt Zaehler und Sperre zurueck; mit `lastLogin` zusaetzlich `lastLoginAt`. */
export async function clearAttempts(userId: string, now: Date, opts: { lastLogin?: boolean } = {}): Promise<void> {
  await dbInternal.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, ...(opts.lastLogin ? { lastLoginAt: now } : {}) },
    select: { id: true },
  });
}

/**
 * Entwertet alle noch offenen Passwort-Reset-Token eines Kontos (als benutzt markiert). Wird
 * in derselben Transaktion aufgerufen, die `passwordChangedAt` setzt (Passwortaenderung,
 * Reset, 2FA-Wechsel): ein vorher angeforderter Link darf nach einer Sicherheitsaenderung
 * nicht mehr funktionieren.
 */
export async function voidResetTokens(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void> {
  await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
}
