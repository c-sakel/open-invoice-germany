/**
 * Phase 17d — Attribute des Zwischen-Cookies `oig_mfa` (setPendingMfa/clearPendingMfa) mit
 * gemocktem next/headers.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const store = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  requestHeaders: new Headers(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: store.set, get: store.get }),
  headers: async () => store.requestHeaders,
}));

import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { MFA_COOKIE, MFA_MAX_AGE } from "@/lib/auth/session";
import { clearPendingMfa, setPendingMfa } from "@/lib/auth/server";

let userId = "";

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const u = await dbInternal.user.create({ data: { email: "pending-mfa-cookie@example.com", passwordHash: hashPassword("irgendein-passwort-1") }, select: { id: true } });
  userId = u.id;
});
beforeEach(() => {
  store.set.mockClear();
  store.requestHeaders = new Headers();
});
afterEach(() => vi.unstubAllEnvs());

describe("Zwischen-Cookie oig_mfa", () => {
  it("setPendingMfa: httpOnly, sameSite strict, Pfad /, maxAge, nicht secure ueber HTTP", async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    await setPendingMfa(userId);
    expect(store.set).toHaveBeenCalledTimes(1);
    const [name, value, opts] = store.set.mock.calls[0];
    expect(name).toBe(MFA_COOKIE);
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(20);
    expect(opts).toEqual({ httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: MFA_MAX_AGE });
    expect(MFA_MAX_AGE).toBe(300);
  });

  it("secure folgt x-forwarded-proto und dem Betreiber-Override", async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    store.requestHeaders = new Headers({ "x-forwarded-proto": "https" });
    await setPendingMfa(userId);
    expect(store.set.mock.calls[0][2].secure).toBe(true);

    store.set.mockClear();
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    await setPendingMfa(userId);
    expect(store.set.mock.calls[0][2].secure).toBe(false);

    store.set.mockClear();
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    store.requestHeaders = new Headers();
    await setPendingMfa(userId);
    expect(store.set.mock.calls[0][2].secure).toBe(true);
  });

  it("clearPendingMfa: leerer Wert, maxAge 0, gleiche Attribute (strict, httpOnly, Pfad /)", async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    store.requestHeaders = new Headers({ "x-forwarded-proto": "https" });
    await clearPendingMfa();
    expect(store.set).toHaveBeenCalledWith(MFA_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0 });
  });
});
