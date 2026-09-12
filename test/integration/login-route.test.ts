/**
 * Phase 14a, Task 8 (R12) — Integrationstests fuer POST /api/auth/login (Route +
 * Domaene `src/domain/auth/login.ts` zusammen). `@/lib/auth/server` wird komplett gemockt
 * (Muster test/integration/invoice-route.test.ts): `cookies()` aus `next/headers`
 * funktioniert ausserhalb eines echten Next-Request-Kontexts nicht, und so laesst sich
 * zusaetzlich direkt beobachten, ob `setSession` ueberhaupt aufgerufen wurde (kein Cookie
 * bei Sperre/Fehlversuch).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const authServerMock = vi.hoisted(() => ({
  setSession: vi.fn(async () => {}),
  getCurrentUserId: vi.fn(async () => null as string | null),
  clearSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server", () => authServerMock);

import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "@/app/api/auth/login/route";

const PASSWORD = "richtiges-passwort-123";
let counter = 0;

async function makeUser() {
  counter += 1;
  const email = `login-route-${counter}@example.com`;
  const user = await dbInternal.user.create({ data: { email, passwordHash: hashPassword(PASSWORD) } });
  return { id: user.id, email };
}

function loginReq(body: unknown, ip?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("x-forwarded-for", ip);
  return new Request("http://x/api/auth/login", { method: "POST", headers, body: JSON.stringify(body) });
}

beforeAll(async () => {
  // Mindestens eine Organisation muss existieren, sonst entfaellt der ActivityLog-Eintrag
  // ersatzlos (Erstinstallation, siehe src/domain/auth/login.ts#findOrgIdForActivityLog) —
  // fuer den Protokoll-Test unten muss der Eintrag tatsaechlich geschrieben werden.
  await dbInternal.organization.create({
    data: { legalName: "Login-Route Test GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
  });
});

beforeEach(() => {
  resetRateLimits();
  authServerMock.setSession.mockClear();
});

describe("POST /api/auth/login", () => {
  it("fuenf Fehlversuche, sechster mit richtigem Passwort: Sperrmeldung (401), kein Cookie", async () => {
    const { email } = await makeUser();
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginReq({ email, password: "falsch" }, "198.51.100.1"));
      expect(res.status).toBe(401);
    }
    const res = await POST(loginReq({ email, password: PASSWORD }, "198.51.100.1"));
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/gesperrt/i);
    expect(authServerMock.setSession).not.toHaveBeenCalled();
  });

  it("nach Ablauf der Sperre ist die Anmeldung wieder erfolgreich (setzt ein Cookie)", async () => {
    const { email, id } = await makeUser();
    for (let i = 0; i < 5; i++) {
      await POST(loginReq({ email, password: "falsch" }, "198.51.100.2"));
    }
    // Sperre kuenstlich in der Vergangenheit "ablaufen lassen" statt 15 Minuten zu warten.
    await dbInternal.user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const res = await POST(loginReq({ email, password: PASSWORD }, "198.51.100.2"));
    expect(res.status).toBe(200);
    expect(authServerMock.setSession).toHaveBeenCalledWith(id);
  });

  it("11 Versuche derselben IP innerhalb des Fensters -> 429 mit Retry-After", async () => {
    const { email } = await makeUser();
    const ip = "198.51.100.3";
    for (let i = 0; i < 10; i++) {
      const res = await POST(loginReq({ email, password: "falsch" }, ip));
      expect(res.status).toBe(401);
    }
    const res = await POST(loginReq({ email, password: "falsch" }, ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("unbekannte E-Mail und falsches Passwort liefern dieselbe Meldung", async () => {
    const { email } = await makeUser();
    const wrongPassword = await POST(loginReq({ email, password: "falsch" }, "198.51.100.4"));
    const unknownEmail = await POST(loginReq({ email: "unbekannt-login-route@example.com", password: "irgendwas" }, "198.51.100.5"));
    expect(wrongPassword.status).toBe(unknownEmail.status);
    const [j1, j2] = await Promise.all([wrongPassword.json(), unknownEmail.json()]);
    expect(j1.error).toBe(j2.error);
  });

  it("ActivityLog-Eintraege zum Fehlversuch enthalten weder E-Mail noch Passwort", async () => {
    const { id, email } = await makeUser();
    await POST(loginReq({ email, password: "falsch-und-geheim" }, "198.51.100.6"));
    const rows = await dbInternal.activityLog.findMany({ where: { entityType: "USER", entityId: id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.dataJson ?? "").not.toContain(email);
      expect(row.dataJson ?? "").not.toContain("falsch-und-geheim");
      expect(row.actor).not.toBe(email);
    }
  });
});
