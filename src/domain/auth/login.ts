/**
 * Anmeldung haerten (Phase 14a, Task 8, R12 — Spec `docs/superpowers/specs/
 * 2026-09-12-phase-14a-fachliche-korrektheit.md`): zwei Bremsen — (a) je IP im Speicher
 * (`rateLimit`, Namensraum `login:`, ueberlebt KEINEN Neustart), (b) je Konto in der
 * Datenbank (`User.failedLoginCount`/`lockedUntil`, ueberlebt einen Neustart). Das
 * Passwort wird IMMER geprueft — bei unbekannter E-Mail gegen einen einmalig berechneten
 * Dummy-Hash — damit die Antwortzeit nichts ueber die Kontoexistenz verraet; die
 * Fehlermeldung ist in beiden Faellen identisch generisch (Route). Nur wer das RICHTIGE
 * Passwort liefert, erfaehrt ueberhaupt von einer Sperre.
 *
 * Ruling (Betreiber-Vorgabe, Dispatch Task 8): der Betreiber darf sich nicht dauerhaft
 * selbst aussperren koennen. Deshalb bleiben Zaehler UND Sperre eingefroren, solange eine
 * Sperre aktiv ist (`isLocked` unten) — weitere Fehlversuche WAEHREND einer laufenden
 * Sperre verlaengern sie nicht. Jede Sperre hat dadurch eine feste Obergrenze von
 * `LOCK_DURATION_MS` ab dem Zeitpunkt, der sie ausgeloest hat; danach ist ein Login mit
 * dem richtigen Passwort sofort wieder moeglich, unabhaengig davon, wie oft es waehrend
 * der Sperre falsch versucht wurde. Die IP-Bremse ist aus demselben Grund ein reines
 * Zeitfenster (kein eskalierender Zaehler) — auch sie kann nicht unbegrenzt wachsen.
 */
import { dbInternal } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { rateLimit } from "@/lib/rate-limit";
import { logActivity } from "@/domain/activity/log";
import { loginSchema, changePasswordSchema } from "@/schemas/auth";

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60_000;
const IP_RATE_LIMIT = 10;
const IP_RATE_WINDOW_MS = 5 * 60_000;

// Einmal beim Laden des Moduls berechnet (scrypt ist bewusst langsam) — derselbe Hash
// wird fuer JEDE unbekannte E-Mail-Adresse verglichen, damit `verifyPassword` fuer
// bekannte und unbekannte Konten denselben Zeitaufwand hat (kein Timing-Seitenkanal ueber
// die Kontoexistenz). Das Klartext-"Passwort" dahinter ist irrelevant, es wird nie mit
// echten Eingaben uebereinstimmen.
const DUMMY_PASSWORD_HASH = hashPassword("dummy-passwort-nur-fuer-konstante-vergleichszeit");

export type LoginResult = { status: "ok"; userId: string } | { status: "invalid" } | { status: "locked"; retryAfterMs: number };

/** Liefert die ID der (einzigen) eingerichteten Organisation oder `null` — anders als
 *  `getActiveOrg()` (src/lib/org.ts) OHNE Exception, damit eine noch nicht eingerichtete
 *  Organisation (Erstinstallation: Konto existiert, Stammdaten noch nicht) den
 *  Anmeldeweg nicht blockiert. ActivityLog verlangt eine orgId — ohne Organisation
 *  entfaellt der Protokolleintrag ersatzlos. */
async function findOrgIdForActivityLog(): Promise<string | null> {
  const org = await dbInternal.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return org?.id ?? null;
}

/** Schreibt einen Anmelde-/Konto-Ereigniseintrag — NIE E-Mail oder Passwort in `data` (R12). */
async function logLoginEvent(userId: string, type: "LOGIN_FAILED" | "LOGIN_LOCKED" | "PASSWORD_CHANGED", ip: string | undefined, reason: string, now: Date): Promise<void> {
  const orgId = await findOrgIdForActivityLog();
  if (!orgId) return; // Erstinstallation ohne Organisation — siehe Moduldoc.
  await logActivity(dbInternal, { orgId, entityType: "USER", entityId: userId, type, actor: userId, at: now, data: { ip: ip ?? null, reason } });
}

/**
 * Prueft E-Mail/Passwort und wendet IP- sowie Konto-Bremse an. Wirft `RateLimitError`
 * (aus `rateLimit`), wenn die IP-Bremse ausgeloest wird — die Route setzt das in HTTP 429
 * mit `Retry-After` um. Wirft `ZodError` bei fehlender/ungueltiger Eingabe (Route -> 400).
 */
export async function attemptLogin(rawInput: unknown, ctx: { ip?: string; now?: Date } = {}): Promise<LoginResult> {
  const input = loginSchema.parse(rawInput);
  const now = ctx.now ?? new Date();

  if (ctx.ip) {
    rateLimit(`login:${ctx.ip}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });
  }

  const user = await dbInternal.user.findUnique({
    where: { email: input.email },
    select: { id: true, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });
  const passwordOk = verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user) {
    // Unbekannte E-Mail: das Passwort wurde bereits (gegen den Dummy-Hash) geprueft, es
    // gibt aber keine entityId zum Protokollieren — die E-Mail selbst darf laut R12 nicht
    // ins Protokoll. Die IP-Bremse oben deckt das Durchprobieren unbekannter Adressen ab.
    return { status: "invalid" };
  }

  const isLocked = user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();

  if (!passwordOk) {
    if (isLocked) {
      // Waehrend einer aktiven Sperre: NICHTS an Zaehler/Sperre aendern (siehe Moduldoc,
      // Ruling gegen dauerhafte Selbstaussperrung) — nur protokollieren.
      await logLoginEvent(user.id, "LOGIN_FAILED", ctx.ip, "falsches Passwort waehrend aktiver Sperre", now);
      return { status: "invalid" };
    }
    const failedLoginCount = user.failedLoginCount + 1;
    const willLock = failedLoginCount >= LOCK_THRESHOLD;
    await dbInternal.user.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil: willLock ? new Date(now.getTime() + LOCK_DURATION_MS) : null },
      select: { id: true },
    });
    await logLoginEvent(user.id, "LOGIN_FAILED", ctx.ip, "falsches Passwort", now);
    if (willLock) {
      await logLoginEvent(user.id, "LOGIN_LOCKED", ctx.ip, `${failedLoginCount} Fehlversuche in Folge`, now);
    }
    return { status: "invalid" };
  }

  // Passwort korrekt.
  if (isLocked) {
    return { status: "locked", retryAfterMs: user.lockedUntil!.getTime() - now.getTime() };
  }

  await dbInternal.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    select: { id: true },
  });
  return { status: "ok", userId: user.id };
}

export type ChangePasswordResult =
  | { status: "ok"; passwordChangedAt: Date }
  | { status: "invalid_current_password" }
  | { status: "locked"; retryAfterMs: number };

/**
 * Aendert das Passwort des ANGEMELDETEN Nutzers (Task 9, R12) — dieselbe IP-Bremse und
 * dieselbe Konto-Sperre/-Schwelle wie `attemptLogin` (ein falsches aktuelles Passwort
 * zaehlt als Fehlversuch, siehe Spec R12/Plan Task 9). Setzt bei Erfolg
 * `passwordHash`/`passwordChangedAt` und setzt Zaehler/Sperre zurueck. Die Route erneuert
 * danach das Session-Cookie NUR des aktuellen Browsers (`setSession`) — jede ANDERE
 * Sitzung traegt noch den alten `pwc`-Wert im Token und wird beim naechsten Zugriff ueber
 * `userIdFromToken`/`getCurrentUserId` (`src/lib/auth/server.ts`) verworfen.
 */
export async function changePassword(userId: string, rawInput: unknown, ctx: { ip?: string; now?: Date } = {}): Promise<ChangePasswordResult> {
  const input = changePasswordSchema.parse(rawInput);
  const now = ctx.now ?? new Date();

  if (ctx.ip) {
    rateLimit(`password-change:${ctx.ip}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });
  }

  const user = await dbInternal.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });
  // Es gibt keinen User-Loeschpfad — eine gueltige Sitzung ohne zugehoerigen User sollte
  // praktisch nie vorkommen, wird aber sicherheitshalber wie ein falsches Passwort
  // behandelt (kein Absturz der Route).
  if (!user) return { status: "invalid_current_password" };

  const isLocked = user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
  const currentOk = verifyPassword(input.currentPassword, user.passwordHash);

  if (!currentOk) {
    if (isLocked) {
      // Wie attemptLogin: waehrend einer aktiven Sperre NICHTS an Zaehler/Sperre aendern.
      await logLoginEvent(user.id, "LOGIN_FAILED", ctx.ip, "falsches aktuelles Passwort waehrend aktiver Sperre (Passwortwechsel)", now);
      return { status: "invalid_current_password" };
    }
    const failedLoginCount = user.failedLoginCount + 1;
    const willLock = failedLoginCount >= LOCK_THRESHOLD;
    await dbInternal.user.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil: willLock ? new Date(now.getTime() + LOCK_DURATION_MS) : null },
      select: { id: true },
    });
    await logLoginEvent(user.id, "LOGIN_FAILED", ctx.ip, "falsches aktuelles Passwort (Passwortwechsel)", now);
    if (willLock) {
      await logLoginEvent(user.id, "LOGIN_LOCKED", ctx.ip, `${failedLoginCount} Fehlversuche in Folge`, now);
    }
    return { status: "invalid_current_password" };
  }

  // Aktuelles Passwort korrekt.
  if (isLocked) {
    return { status: "locked", retryAfterMs: user.lockedUntil!.getTime() - now.getTime() };
  }

  const passwordHash = hashPassword(input.newPassword);
  await dbInternal.user.update({
    where: { id: user.id },
    data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    select: { id: true },
  });
  await logLoginEvent(user.id, "PASSWORD_CHANGED", ctx.ip, "Passwort erfolgreich geaendert", now);
  return { status: "ok", passwordChangedAt: now };
}
