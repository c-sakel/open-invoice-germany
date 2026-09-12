/**
 * Phase 14a, Task 9 (R12) — Integrationstests fuer POST /api/auth/password (Route +
 * Domaene `src/domain/auth/login.ts#changePassword`) UND die Sitzungsentwertung nach
 * einem Passwortwechsel (`src/lib/auth/server.ts#userIdFromToken`).
 *
 * `getCurrentUserId`/`setSession` werden gemockt — `next/headers#cookies()` funktioniert
 * ausserhalb eines echten Next-Request-Kontexts nicht (Muster
 * test/integration/login-route.test.ts). `userIdFromToken` bleibt dabei die ECHTE
 * Implementierung (`importOriginal`), damit die eigentliche Sitzungsentwertungs-Logik
 * (Token-`pwc` gegen `User.passwordChangedAt`) direkt getestet werden kann, ohne
 * next/headers zu brauchen.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const authServerMock = vi.hoisted(() => ({
  currentUserId: null as string | null,
  setSession: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return {
    ...actual,
    getCurrentUserId: vi.fn(async () => authServerMock.currentUserId),
    setSession: authServerMock.setSession,
  };
});

import { dbInternal } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { resetRateLimits } from "@/lib/rate-limit";
import { createSessionToken } from "@/lib/auth/session";
import { userIdFromToken } from "@/lib/auth/server";
import { changePassword } from "@/domain/auth/login";
import { POST } from "@/app/api/auth/password/route";

const CURRENT_PASSWORD = "aktuelles-passwort-123";
const NEW_PASSWORD = "neues-sicheres-passwort-2026";
let counter = 0;

async function makeUser() {
  counter += 1;
  const email = `password-change-${counter}@example.com`;
  return dbInternal.user.create({ data: { email, passwordHash: hashPassword(CURRENT_PASSWORD) } });
}

function passwordReq(body: unknown, ip?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("x-forwarded-for", ip);
  return new Request("http://x/api/auth/password", { method: "POST", headers, body: JSON.stringify(body) });
}

beforeAll(async () => {
  // Mindestens eine Organisation muss existieren, sonst entfaellt der ActivityLog-Eintrag
  // ersatzlos (Erstinstallation, siehe src/domain/auth/login.ts#findOrgIdForActivityLog).
  await dbInternal.organization.create({
    data: { legalName: "Passwortwechsel Test GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
  });
});

beforeEach(() => {
  resetRateLimits();
  authServerMock.currentUserId = null;
  authServerMock.setSession.mockClear();
});

describe("POST /api/auth/password", () => {
  it("ohne Session -> 401, kein Cookie", async () => {
    const res = await passwordReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD });
    const response = await POST(res);
    expect(response.status).toBe(401);
    expect(authServerMock.setSession).not.toHaveBeenCalled();
  });

  it("falsches aktuelles Passwort -> 401, Fehlversuchszaehler +1", async () => {
    const user = await makeUser();
    authServerMock.currentUserId = user.id;
    const response = await POST(passwordReq({ currentPassword: "falsch", newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, "203.0.113.1"));
    expect(response.status).toBe(401);
    const j = (await response.json()) as { error: string };
    expect(j.error).toMatch(/falsch/i);
    const updated = await dbInternal.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.failedLoginCount).toBe(1);
    expect(authServerMock.setSession).not.toHaveBeenCalled();
  });

  it("neues Passwort zu kurz -> 400", async () => {
    const user = await makeUser();
    authServerMock.currentUserId = user.id;
    const response = await POST(passwordReq({ currentPassword: CURRENT_PASSWORD, newPassword: "kurz1234", newPasswordRepeat: "kurz1234" }));
    expect(response.status).toBe(400);
  });

  it("Wiederholung stimmt nicht mit dem neuen Passwort ueberein -> 400", async () => {
    const user = await makeUser();
    authServerMock.currentUserId = user.id;
    const response = await POST(passwordReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: "anders-12345678" }));
    expect(response.status).toBe(400);
  });

  it("erfolgreicher Wechsel: 200, frisches Cookie, Passwort in der DB tatsaechlich geaendert", async () => {
    const user = await makeUser();
    authServerMock.currentUserId = user.id;
    const response = await POST(passwordReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, "203.0.113.2"));
    expect(response.status).toBe(200);
    expect(authServerMock.setSession).toHaveBeenCalledWith(user.id);

    const updated = await dbInternal.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verifyPassword(NEW_PASSWORD, updated.passwordHash)).toBe(true);
    expect(verifyPassword(CURRENT_PASSWORD, updated.passwordHash)).toBe(false);
    expect(updated.passwordChangedAt).not.toBeNull();
    expect(updated.failedLoginCount).toBe(0);
  });

  it("11 Versuche derselben IP innerhalb des Fensters -> 429 mit Retry-After", async () => {
    const user = await makeUser();
    authServerMock.currentUserId = user.id;
    const ip = "203.0.113.3";
    for (let i = 0; i < 10; i++) {
      const response = await POST(passwordReq({ currentPassword: "falsch", newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, ip));
      expect(response.status).toBe(401);
    }
    const response = await POST(passwordReq({ currentPassword: "falsch", newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, ip));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).not.toBeNull();
  });

  it("ActivityLog-Eintrag zum erfolgreichen Wechsel enthaelt weder E-Mail noch Passwort", async () => {
    const user = await makeUser();
    authServerMock.currentUserId = user.id;
    await POST(passwordReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, "203.0.113.4"));
    const rows = await dbInternal.activityLog.findMany({ where: { entityType: "USER", entityId: user.id, type: "PASSWORD_CHANGED" } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.dataJson ?? "").not.toContain(user.email);
    expect(rows[0]!.dataJson ?? "").not.toContain(NEW_PASSWORD);
    expect(rows[0]!.actor).toBe(user.id);
  });
});

describe("Sitzungsentwertung nach Passwortwechsel (userIdFromToken)", () => {
  it("ein VOR dem Wechsel ausgestelltes Token wird danach verworfen, ein frisches Token bleibt gueltig", async () => {
    const user = await makeUser();
    // Konto hat sein Passwort noch nie geaendert -> passwordChangedAt/pwc NULL.
    const oldToken = await createSessionToken(user.id, null);
    expect(await userIdFromToken(oldToken)).toBe(user.id);

    authServerMock.currentUserId = user.id;
    const response = await POST(passwordReq({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, "203.0.113.5"));
    expect(response.status).toBe(200);

    // Das alte Token traegt noch pwc=null, passt aber nicht mehr zum jetzt gesetzten
    // passwordChangedAt -> die Sitzung ist entwertet.
    expect(await userIdFromToken(oldToken)).toBeNull();

    // Ein frisches Token MIT dem aktuellen passwordChangedAt bleibt gueltig — genau das
    // baut `setSession` in der echten Implementierung nach (hier direkt nachgebaut, weil
    // `setSession` oben gemockt ist und next/headers braucht).
    const updated = await dbInternal.user.findUniqueOrThrow({ where: { id: user.id } });
    const freshToken = await createSessionToken(user.id, updated.passwordChangedAt!.getTime());
    expect(await userIdFromToken(freshToken)).toBe(user.id);
  });
});

describe("changePassword — Kontosperre nach Ablauf (Fix-Welle 4, must 1, Konsistenzfix zu attemptLogin)", () => {
  it("ein falsches aktuelles Passwort nach abgelaufener Sperre sperrt NICHT sofort wieder", async () => {
    const user = await makeUser();
    const now = new Date("2037-02-01T10:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await changePassword(user.id, { currentPassword: "falsch", newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, { now });
    }
    const locked = await dbInternal.user.findUniqueOrThrow({ where: { id: user.id }, select: { failedLoginCount: true, lockedUntil: true } });
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil).not.toBeNull();

    const afterLockExpired = new Date(now.getTime() + 16 * 60_000);
    const res = await changePassword(user.id, { currentPassword: "immer-noch-falsch", newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, { now: afterLockExpired });
    expect(res.status).toBe("invalid_current_password");
    const afterOneMore = await dbInternal.user.findUniqueOrThrow({ where: { id: user.id }, select: { failedLoginCount: true, lockedUntil: true } });
    expect(afterOneMore.failedLoginCount).toBe(1);
    expect(afterOneMore.lockedUntil).toBeNull();

    const okRes = await changePassword(user.id, { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD }, { now: new Date(afterLockExpired.getTime() + 1000) });
    expect(okRes.status).toBe("ok");
  });
});
