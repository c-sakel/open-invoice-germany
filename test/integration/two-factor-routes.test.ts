/**
 * Phase 17d, Task 4 — Routen der Zwei-Faktor-Anmeldung: Login mit Zwischen-Cookie,
 * second-factor, Konto-Routen unter /api/account/totp. `@/lib/auth/server` ist gemockt
 * (cookies() gibt es ausserhalb eines Next-Request-Kontexts nicht).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const auth = vi.hoisted(() => ({
  pending: null as { uid: string; pwc: number | null } | null,
  currentUser: null as string | null,
  setSession: vi.fn(async (_uid: string) => {}),
  setPendingMfa: vi.fn(async (_uid: string) => {}),
  clearPendingMfa: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server", () => ({
  setSession: auth.setSession,
  setPendingMfa: auth.setPendingMfa,
  clearPendingMfa: auth.clearPendingMfa,
  clearSession: auth.clearSession,
  readPendingMfa: vi.fn(async () => auth.pending),
  getCurrentUserId: vi.fn(async () => auth.currentUser),
}));

import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { resetRateLimits } from "@/lib/rate-limit";
import { base32Decode, hotp, totpStep } from "@/lib/auth/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as secondFactor } from "@/app/api/auth/second-factor/route";
import { POST as setup } from "@/app/api/account/totp/setup/route";
import { POST as enable } from "@/app/api/account/totp/enable/route";
import { POST as disable } from "@/app/api/account/totp/disable/route";
import { POST as renew } from "@/app/api/account/totp/recovery-codes/route";

const PASSWORD = "richtiges-passwort-123";
let counter = 0;

function req(url: string, body: unknown, ip = "198.51.100.10"): Request {
  return new Request(`http://x${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function totp(secret: Buffer, offset = 0): string {
  return hotp(secret, totpStep(new Date()) + offset);
}
function ipFor(): string {
  counter += 1;
  return `203.0.113.${counter % 250}`;
}

async function makeUser() {
  counter += 1;
  const email = `tf-routes-${counter}@example.com`;
  const u = await dbInternal.user.create({ data: { email, passwordHash: hashPassword(PASSWORD) } });
  return { id: u.id, email };
}

/** Aktive 2FA ueber die Routen (Konto-Sitzung); liefert Geheimnis und Wiederherstellungscodes. */
async function activate() {
  const u = await makeUser();
  auth.currentUser = u.id;
  const ip = ipFor();
  const s = (await (await setup(req("/api/account/totp/setup", {}, ip))).json()) as { secret: string };
  const secret = base32Decode(s.secret);
  const res = await enable(req("/api/account/totp/enable", { password: PASSWORD, code: totp(secret) }, ip));
  const j = (await res.json()) as { recoveryCodes: string[] };
  auth.currentUser = null;
  return { ...u, secret, recoveryCodes: j.recoveryCodes };
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  await dbInternal.organization.create({
    data: { legalName: "Zwei-Faktor Routen GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
  });
});

beforeEach(() => {
  resetRateLimits();
  auth.pending = null;
  auth.currentUser = null;
  for (const m of [auth.setSession, auth.setPendingMfa, auth.clearPendingMfa]) m.mockClear();
});

describe("POST /api/auth/login mit zweitem Faktor", () => {
  it("aktive 2FA: { twoFactor: true }, Zwischen-Cookie, keine Sitzung", async () => {
    const a = await activate();
    const res = await login(req("/api/auth/login", { email: a.email, password: PASSWORD }, ipFor()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ twoFactor: true });
    expect(auth.setPendingMfa).toHaveBeenCalledWith(a.id);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it("ohne 2FA unveraendert { ok: true } und Sitzung", async () => {
    const u = await makeUser();
    const res = await login(req("/api/auth/login", { email: u.email, password: PASSWORD }, ipFor()));
    expect(await res.json()).toEqual({ ok: true });
    expect(auth.setSession).toHaveBeenCalledWith(u.id);
    expect(auth.setPendingMfa).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/second-factor", () => {
  it("ohne Zwischen-Cookie: 401, keine Sitzung", async () => {
    const res = await secondFactor(req("/api/auth/second-factor", { code: "123456" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/abgelaufen/);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it("richtiger Code: 200, Sitzung, Zwischen-Cookie geloescht", async () => {
    const a = await activate();
    auth.pending = { uid: a.id, pwc: null };
    const res = await secondFactor(req("/api/auth/second-factor", { code: totp(a.secret, 1) }, ipFor()));
    expect(res.status).toBe(200);
    expect(auth.setSession).toHaveBeenCalledWith(a.id);
    expect(auth.clearPendingMfa).toHaveBeenCalled();
  });

  it("Wiederherstellungscode wird akzeptiert", async () => {
    const a = await activate();
    auth.pending = { uid: a.id, pwc: null };
    const res = await secondFactor(req("/api/auth/second-factor", { code: a.recoveryCodes[0] }, ipFor()));
    expect(res.status).toBe(200);
  });

  it("falscher Code: 401 'Code ist falsch.'; fuenf falsche: danach gesperrt mit Retry-After", async () => {
    const a = await activate();
    auth.pending = { uid: a.id, pwc: null };
    const ip = ipFor();
    const first = await secondFactor(req("/api/auth/second-factor", { code: "000000" }, ip));
    expect(first.status).toBe(401);
    expect(((await first.json()) as { error: string }).error).toBe("Code ist falsch.");
    for (let i = 0; i < 4; i++) await secondFactor(req("/api/auth/second-factor", { code: "000000" }, ip));
    const locked = await secondFactor(req("/api/auth/second-factor", { code: totp(a.secret, 1) }, ip));
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as { error: string }).error).toMatch(/gesperrt/);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it("11. Anfrage einer IP (Login und Codes gemischt): 429", async () => {
    const ip = ipFor();
    for (let i = 0; i < 5; i++) await login(req("/api/auth/login", { email: "nobody@example.com", password: "x" }, ip));
    auth.pending = { uid: "x", pwc: null };
    for (let i = 0; i < 5; i++) await secondFactor(req("/api/auth/second-factor", { code: "000000" }, ip));
    await login(req("/api/auth/login", { email: "nobody@example.com", password: "x" }, ip));
    const res = await secondFactor(req("/api/auth/second-factor", { code: "000000" }, ip));
    expect(res.status).toBe(429);
  });

  it("ungueltiger Body: 400", async () => {
    const a = await activate();
    auth.pending = { uid: a.id, pwc: null };
    const res = await secondFactor(req("/api/auth/second-factor", { code: "1" }, ipFor()));
    expect(res.status).toBe(400);
  });
});

describe("Konto-Routen /api/account/totp/*", () => {
  it("ohne Sitzung je 401", async () => {
    for (const [fn, url] of [
      [setup, "setup"],
      [enable, "enable"],
      [disable, "disable"],
      [renew, "recovery-codes"],
    ] as const) {
      const res = await fn(req(`/api/account/totp/${url}`, {}));
      expect(res.status).toBe(401);
    }
  });

  it("setup: 200, no-store; enable falsch 400, richtig 200 mit 10 Codes; setup danach 409", async () => {
    const u = await makeUser();
    auth.currentUser = u.id;
    const ip = ipFor();
    const s = await setup(req("/api/account/totp/setup", {}, ip));
    expect(s.status).toBe(200);
    expect(s.headers.get("cache-control")).toBe("no-store");
    const j = (await s.json()) as { secret: string; otpauthUri: string; qrDataUrl: string };
    expect(j.qrDataUrl.startsWith("data:image/png")).toBe(true);

    const bad = await enable(req("/api/account/totp/enable", { password: PASSWORD, code: "000000" }, ip));
    expect(bad.status).toBe(400);
    const ok = await enable(req("/api/account/totp/enable", { password: PASSWORD, code: totp(base32Decode(j.secret)) }, ip));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);

    expect((await setup(req("/api/account/totp/setup", {}, ip))).status).toBe(409);
  });

  it("disable: falsches Passwort 401; Passwort + Wiederherstellungscode 200", async () => {
    const a = await activate();
    auth.currentUser = a.id;
    const ip = ipFor();
    const bad = await disable(req("/api/account/totp/disable", { password: "falsch", code: a.recoveryCodes[0] }, ip));
    expect(bad.status).toBe(401);
    const ok = await disable(req("/api/account/totp/disable", { password: PASSWORD, code: a.recoveryCodes[0] }, ip));
    expect(ok.status).toBe(200);
    const row = await dbInternal.user.findUniqueOrThrow({ where: { id: a.id }, select: { totpEnabledAt: true } });
    expect(row.totpEnabledAt).toBeNull();
  });

  it("recovery-codes: erneuert, 10 neue Codes", async () => {
    const a = await activate();
    auth.currentUser = a.id;
    const res = await renew(req("/api/account/totp/recovery-codes", { password: PASSWORD, code: a.recoveryCodes[0] }, ipFor()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
  });

  it("ohne AUTH_SECRET: setup 409 mit Hinweis", async () => {
    const u = await makeUser();
    auth.currentUser = u.id;
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      const res = await setup(req("/api/account/totp/setup", {}, ipFor()));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/AUTH_SECRET/);
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });

  it("IP-Bremse account-security: 11. Anfrage -> 429", async () => {
    const u = await makeUser();
    auth.currentUser = u.id;
    const ip = ipFor();
    for (let i = 0; i < 10; i++) await disable(req("/api/account/totp/disable", { password: "x", code: "000000" }, ip));
    const res = await disable(req("/api/account/totp/disable", { password: "x", code: "000000" }, ip));
    expect(res.status).toBe(429);
  });
});
