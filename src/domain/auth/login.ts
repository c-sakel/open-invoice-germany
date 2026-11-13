/**
 * Anmeldung haerten (Phase 14a, Task 8, R12 — Spec `docs/superpowers/specs/
 * 2026-09-12-phase-14a-fachliche-korrektheit.md`): zwei Bremsen — (a) je IP im Speicher
 * (`rateLimit`, Namensraum `login:`, ueberlebt KEINEN Neustart), (b) je Konto in der
 * Datenbank (`User.failedLoginCount`/`lockedUntil`, ueberlebt einen Neustart). Das
 * Passwort wird IMMER geprueft — bei unbekannter E-Mail gegen einen einmalig berechneten
 * Dummy-Hash — damit die Antwortzeit nichts ueber die Kontoexistenz verraet; die
 * Fehlermeldung ist in beiden Faellen identisch generisch (Route). Waehrend einer
 * Sperre antwortet jede Anfrage gleich (`locked`), das Passwort wird nicht ausgewertet.
 *
 * Ruling (Betreiber-Vorgabe, Dispatch Task 8): der Betreiber darf sich nicht dauerhaft
 * selbst aussperren koennen. Deshalb bleiben Zaehler UND Sperre eingefroren, solange eine
 * Sperre aktiv ist (`isLocked` unten) — weitere Fehlversuche WAEHREND einer laufenden
 * Sperre verlaengern sie nicht. Jede Sperre hat dadurch eine feste Obergrenze von
 * `LOCK_DURATION_MS` ab dem Zeitpunkt, der sie ausgeloest hat; danach ist ein Login mit
 * dem richtigen Passwort sofort wieder moeglich, unabhaengig davon, wie oft es waehrend
 * der Sperre falsch versucht wurde. Die IP-Bremse ist aus demselben Grund ein reines
 * Zeitfenster (kein eskalierender Zaehler) — auch sie kann nicht unbegrenzt wachsen.
 *
 * Fix-Welle 3 (Review zu Task 8) — drei Nachbesserungen:
 * (1) must, Laufzeit-Leak: der Pfad fuer eine UNBEKANNTE E-Mail kehrte bisher sofort
 *     zurueck, waehrend eine BEKANNTE E-Mail zusaetzliche Schreibvorgaenge ausloeste
 *     (Konto-Update, Organisations-Lookup, ActivityLog-Eintrag) — der Dummy-Hash deckt
 *     nur den reinen Passwortvergleich ab, nicht diese zusaetzliche Laufzeit. Eine
 *     unbekannte E-Mail protokolliert deshalb jetzt ebenfalls einen Fehlversuch (gleiche
 *     Organisations-Lookup- und Schreibarbeit wie ein bekanntes Konto), nur ohne
 *     Konto-Update (es gibt kein Konto) und mit einem festen Platzhalter statt einer
 *     echten Konto-ID (`UNKNOWN_ACCOUNT_ID` unten) — die E-Mail selbst darf laut R12
 *     ohnehin nie ins Protokoll. Kein kuenstliches Warten als Ersatz fuer Symmetrie.
 * (2) must, IP-Bremse ohne Proxy-Header: `ctx.ip` kann fehlen (kein Reverse-Proxy-Header) —
 *     die Bremse griff dann bisher gar nicht. Wie `checkPreAuthRateLimit`
 *     (src/api/rate-limit.ts:34) teilen sich fehlende IPs jetzt einen gemeinsamen
 *     "unknown"-Bucket, statt ungebremst zu bleiben.
 * (3) should, ActivityLog-Wachstum waehrend einer aktiven Sperre: bisher wurde JEDER
 *     weitere Fehlversuch waehrend einer laufenden Sperre protokolliert (unbegrenztes
 *     Wachstum bei einem andauernden Angriff). Die Sperre selbst wird bereits beim
 *     Ausloesen protokolliert (`LOGIN_LOCKED`) — waehrend sie aktiv ist, entsteht jetzt
 *     kein weiterer Log-Eintrag mehr je Versuch.
 */
import { dbInternal } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { rateLimit } from "@/lib/rate-limit";
import { loginSchema, changePasswordSchema } from "@/schemas/auth";
import {
  IP_RATE_LIMIT,
  IP_RATE_WINDOW_MS,
  UNKNOWN_ACCOUNT_ID,
  clearAttempts,
  lockState,
  logAccountEvent,
  registerFailedAttempt,
  voidResetTokens,
} from "@/domain/auth/attempts";

// Einmal beim Laden des Moduls berechnet (scrypt ist bewusst langsam) — derselbe Hash
// wird fuer JEDE unbekannte E-Mail-Adresse verglichen, damit `verifyPassword` fuer
// bekannte und unbekannte Konten denselben Zeitaufwand hat (kein Timing-Seitenkanal ueber
// die Kontoexistenz). Das Klartext-"Passwort" dahinter ist irrelevant, es wird nie mit
// echten Eingaben uebereinstimmen.
const DUMMY_PASSWORD_HASH = hashPassword("dummy-passwort-nur-fuer-konstante-vergleichszeit");

export type LoginResult = { status: "ok"; userId: string } | { status: "second_factor"; userId: string } | { status: "invalid" } | { status: "locked"; retryAfterMs: number };

/**
 * Prueft E-Mail/Passwort und wendet IP- sowie Konto-Bremse an. Wirft `RateLimitError`
 * (aus `rateLimit`), wenn die IP-Bremse ausgeloest wird — die Route setzt das in HTTP 429
 * mit `Retry-After` um. Wirft `ZodError` bei fehlender/ungueltiger Eingabe (Route -> 400).
 */
export async function attemptLogin(rawInput: unknown, ctx: { ip?: string; now?: Date } = {}): Promise<LoginResult> {
  const input = loginSchema.parse(rawInput);
  const now = ctx.now ?? new Date();

  // IP-Bremse IMMER anwenden (Fix-Welle 3, must) — auch ohne Proxy-Header teilen sich
  // fehlende IPs einen gemeinsamen "unknown"-Bucket (Muster checkPreAuthRateLimit,
  // src/api/rate-limit.ts:34), statt ungebremst zu bleiben.
  rateLimit(`login:${ctx.ip ?? "unknown"}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });

  const user = await dbInternal.user.findUnique({
    where: { email: input.email },
    select: { id: true, passwordHash: true, failedLoginCount: true, lockedUntil: true, totpEnabledAt: true },
  });
  const passwordOk = verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user) {
    // Unbekannte E-Mail (Fix-Welle 3, must — Laufzeit-Leak): dieselbe Protokollarbeit wie
    // ein Fehlversuch gegen ein bekanntes Konto (Organisations-Lookup + ActivityLog-
    // Eintrag), damit die Laufzeit nicht mehr verraet, ob die Adresse existiert. Kein
    // Konto-Update (es gibt kein Konto) und keine echte entityId — die E-Mail selbst
    // darf laut R12 nicht ins Protokoll, `UNKNOWN_ACCOUNT_ID` ist ein fester Platzhalter.
    await logAccountEvent(UNKNOWN_ACCOUNT_ID, "LOGIN_FAILED", ctx.ip, "unbekannte E-Mail-Adresse", now);
    return { status: "invalid" };
  }

  const { isLocked, retryAfterMs } = lockState(user, now);

  // Waehrend einer aktiven Sperre gibt es nur EINE Antwort, unabhaengig vom Passwort —
  // sonst waere die Sperre ein Passwort-Orakel (richtig -> "locked", falsch -> "invalid").
  // Der scrypt-Vergleich oben lief trotzdem (gleiche Laufzeit), das Ergebnis wird nicht benutzt.
  if (isLocked) return { status: "locked", retryAfterMs };

  if (!passwordOk) {
    await registerFailedAttempt(user, { ip: ctx.ip, now }, "falsches Passwort");
    return { status: "invalid" };
  }

  if (user.totpEnabledAt !== null) {
    // Zweiter Faktor aktiv: Zaehler und Sperre bleiben UNVERAENDERT und `lastLoginAt` wird
    // nicht gesetzt — wer das Passwort kennt, soll den Fehlversuchszaehler nicht per
    // richtigem Passwort zuruecksetzen koennen, sonst waeren Codeversuche unbegrenzt
    // (Passwort, falscher Code, Passwort, ...). Zurueckgesetzt wird erst nach bestandenem
    // zweiten Faktor (`verifySecondFactor`).
    return { status: "second_factor", userId: user.id };
  }

  await clearAttempts(user.id, now, { lastLogin: true });
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

  // IP-Bremse IMMER anwenden — Konsistenzfix zu Fix-Welle 3 (dasselbe Muster wie
  // attemptLogin oben): auch hier darf eine fehlende IP die Bremse nicht umgehen.
  rateLimit(`password-change:${ctx.ip ?? "unknown"}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS, now: now.getTime() });

  const user = await dbInternal.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, failedLoginCount: true, lockedUntil: true },
  });
  // Es gibt keinen User-Loeschpfad — eine gueltige Sitzung ohne zugehoerigen User sollte
  // praktisch nie vorkommen, wird aber sicherheitshalber wie ein falsches Passwort
  // behandelt (kein Absturz der Route).
  if (!user) return { status: "invalid_current_password" };

  const { isLocked, retryAfterMs } = lockState(user, now);
  const currentOk = verifyPassword(input.currentPassword, user.passwordHash);

  // Wie attemptLogin: waehrend der Sperre antwortet nur "locked", das Passwort bleibt ungeprueft.
  if (isLocked) return { status: "locked", retryAfterMs };

  if (!currentOk) {
    await registerFailedAttempt(user, { ip: ctx.ip, now }, "falsches aktuelles Passwort (Passwortwechsel)");
    return { status: "invalid_current_password" };
  }

  const passwordHash = hashPassword(input.newPassword);
  await dbInternal.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
      select: { id: true },
    });
    // Offene Reset-Links verfallen mit der Passwortaenderung.
    await voidResetTokens(tx, user.id, now);
  });
  await logAccountEvent(user.id, "PASSWORD_CHANGED", ctx.ip, "Passwort erfolgreich geaendert", now);
  return { status: "ok", passwordChangedAt: now };
}
