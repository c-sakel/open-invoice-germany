/**
 * Phase 14a, Task 8 (R12) — Sperrlogik von `attemptLogin` (src/domain/auth/login.ts).
 * Reine Domain-Tests: 4 Fehlversuche keine Sperre, der 5. sperrt, waehrend einer aktiven
 * Sperre veraendert sich nichts mehr (Ruling gegen dauerhafte Selbstaussperrung), eine
 * abgelaufene Sperre laesst wieder zu, Erfolg setzt den Zaehler zurueck.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { attemptLogin } from "@/domain/auth/login";
import { hashPassword } from "@/lib/auth/password";
import { resetRateLimits } from "@/lib/rate-limit";

const PASSWORD = "richtiges-passwort-123";
let counter = 0;

async function makeUser() {
  counter += 1;
  const email = `login-lock-${counter}@example.com`;
  const user = await dbInternal.user.create({ data: { email, passwordHash: hashPassword(PASSWORD) } });
  return { id: user.id, email };
}

beforeEach(() => {
  resetRateLimits();
});

describe("attemptLogin — Kontosperre", () => {
  it("4 Fehlversuche in Folge sperren noch nicht", async () => {
    const { email } = await makeUser();
    for (let i = 0; i < 4; i++) {
      const res = await attemptLogin({ email, password: "falsch" });
      expect(res.status).toBe("invalid");
    }
    const row = await dbInternal.user.findUniqueOrThrow({ where: { email }, select: { failedLoginCount: true, lockedUntil: true } });
    expect(row.failedLoginCount).toBe(4);
    expect(row.lockedUntil).toBeNull();
  });

  it("der 5. Fehlversuch sperrt fuer 15 Minuten", async () => {
    const { email } = await makeUser();
    const now = new Date("2037-01-01T10:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      const res = await attemptLogin({ email, password: "falsch" }, { now });
      expect(res.status).toBe("invalid");
    }
    const row = await dbInternal.user.findUniqueOrThrow({ where: { email }, select: { failedLoginCount: true, lockedUntil: true } });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil?.toISOString()).toBe("2037-01-01T10:15:00.000Z");
  });

  it("richtiges Passwort waehrend aktiver Sperre liefert 'locked' mit Restzeit, keine Sitzung", async () => {
    const { email } = await makeUser();
    const now = new Date("2037-01-01T10:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await attemptLogin({ email, password: "falsch" }, { now });
    }
    const tenMinutesLater = new Date(now.getTime() + 10 * 60_000);
    const res = await attemptLogin({ email, password: PASSWORD }, { now: tenMinutesLater });
    expect(res.status).toBe("locked");
    if (res.status === "locked") {
      expect(res.retryAfterMs).toBe(5 * 60_000); // 15 Min. Sperre minus 10 Min. vergangen
    }
  });

  it("weitere Fehlversuche WAEHREND einer aktiven Sperre verlaengern sie nicht (keine dauerhafte Selbstaussperrung)", async () => {
    const { email } = await makeUser();
    const now = new Date("2037-01-01T10:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await attemptLogin({ email, password: "falsch" }, { now });
    }
    const rowAfterLock = await dbInternal.user.findUniqueOrThrow({ where: { email }, select: { lockedUntil: true, failedLoginCount: true } });

    // Fuenf weitere falsche Versuche, mitten in der Sperre.
    const fiveMinutesLater = new Date(now.getTime() + 5 * 60_000);
    for (let i = 0; i < 5; i++) {
      const res = await attemptLogin({ email, password: "immer-noch-falsch" }, { now: fiveMinutesLater });
      expect(res.status).toBe("invalid");
    }

    const rowAfterMoreAttempts = await dbInternal.user.findUniqueOrThrow({ where: { email }, select: { lockedUntil: true, failedLoginCount: true } });
    expect(rowAfterMoreAttempts.lockedUntil?.toISOString()).toBe(rowAfterLock.lockedUntil?.toISOString());
    expect(rowAfterMoreAttempts.failedLoginCount).toBe(rowAfterLock.failedLoginCount);
  });

  it("eine abgelaufene Sperre laesst ein richtiges Passwort wieder zu", async () => {
    const { email } = await makeUser();
    const now = new Date("2037-01-01T10:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await attemptLogin({ email, password: "falsch" }, { now });
    }
    const afterLockExpired = new Date(now.getTime() + 16 * 60_000);
    const res = await attemptLogin({ email, password: PASSWORD }, { now: afterLockExpired });
    expect(res.status).toBe("ok");
  });

  it("Erfolg setzt Zaehler/Sperre zurueck und setzt lastLoginAt", async () => {
    const { email, id } = await makeUser();
    const now = new Date("2037-01-01T10:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      await attemptLogin({ email, password: "falsch" }, { now });
    }
    const res = await attemptLogin({ email, password: PASSWORD }, { now });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.userId).toBe(id);

    const row = await dbInternal.user.findUniqueOrThrow({ where: { email }, select: { failedLoginCount: true, lockedUntil: true, lastLoginAt: true } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.lastLoginAt?.toISOString()).toBe(now.toISOString());
  });

  it("unbekannte E-Mail liefert 'invalid', ohne eine Zeile anzulegen oder zu aendern", async () => {
    const res = await attemptLogin({ email: "unbekannt-login-lock@example.com", password: "irgendwas" });
    expect(res.status).toBe("invalid");
  });

  it("IP-Bremse: 11. Versuch derselben IP innerhalb des Fensters wirft RateLimitError", async () => {
    const { email } = await makeUser();
    const now = new Date("2037-01-01T10:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      await attemptLogin({ email, password: "falsch" }, { ip: "203.0.113.9", now });
    }
    await expect(attemptLogin({ email, password: "falsch" }, { ip: "203.0.113.9", now })).rejects.toThrow();
  });
});
