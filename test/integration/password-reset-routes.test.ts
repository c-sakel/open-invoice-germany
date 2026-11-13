/**
 * Phase 17d, Task 5 — Routen des Passwort-Resets: byte-gleiche Antworten ohne Konto-Aufzaehlung,
 * Versand erst nach der Antwort (`after()`), Link nur aus APP_BASE_URL.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  afterQueue: [] as Array<() => unknown>,
  orgId: "",
  memory: null as null | { sent: Array<{ to: string[]; text: string; cc: string[]; bcc: string[] }>; send: (m: never) => Promise<{ providerId: string | null }> },
}));

vi.mock("next/server", async (orig) => {
  const actual = await orig<typeof import("next/server")>();
  return { ...actual, after: (fn: () => unknown) => { hoisted.afterQueue.push(fn); } };
});
vi.mock("@/lib/mail/smtp", () => ({ createSmtpProvider: () => hoisted.memory }));
vi.mock("@/domain/auth/instance", () => ({ instanceOrgId: async () => hoisted.orgId }));

import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { resetRateLimits } from "@/lib/rate-limit";
import { createMemoryProvider } from "@/lib/mail/memory";
import { saveMailSettings } from "@/domain/email/settings";
import { beginTotpSetup, enableTotp } from "@/domain/auth/two-factor";
import { base32Decode, hotp, totpStep } from "@/lib/auth/totp";
import { POST as request } from "@/app/api/auth/password-reset/request/route";
import { POST as confirm } from "@/app/api/auth/password-reset/confirm/route";

const PASSWORD = "richtiges-passwort-123";
const NEW_PASSWORD = "ein-ganz-neues-passwort-1";
let counter = 0;
let ipCounter = 0;

function ip(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}
function req(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://x${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...headers },
    body: JSON.stringify(body),
  });
}
async function makeUser() {
  counter += 1;
  const email = `pw-reset-route-${counter}@example.com`;
  const u = await dbInternal.user.create({ data: { email, passwordHash: hashPassword(PASSWORD) } });
  return { id: u.id, email };
}
async function flush() {
  const q = hoisted.afterQueue.splice(0);
  for (const fn of q) await fn();
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Reset Routen GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
    select: { id: true },
  });
  hoisted.orgId = org.id;
  await saveMailSettings(org.id, {
    host: "smtp.example.test", port: 587, security: "STARTTLS", username: "u", password: "p",
    fromName: "Reset", fromEmail: "absender@example.test", defaultCc: "", defaultBcc: "", copyToSelf: false,
  });
});

beforeEach(() => {
  resetRateLimits();
  hoisted.afterQueue.length = 0;
  hoisted.memory = createMemoryProvider() as unknown as typeof hoisted.memory;
  vi.stubEnv("APP_BASE_URL", "https://rechnung.example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/password-reset/request", () => {
  it("bekannte, unbekannte, limitierte und nicht eingerichtete E-Mail: identische Antwort", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const known = await makeUser();
    const limited = await makeUser();
    const responses: Array<{ status: number; body: string }> = [];
    const grab = async (email: string) => {
      const r = await request(req("/api/auth/password-reset/request", { email }));
      responses.push({ status: r.status, body: await r.text() });
    };
    await grab(known.email);
    await grab("unbekannt@example.com");
    for (let i = 0; i < 4; i++) await grab(limited.email); // 4. liegt ueber dem Kontolimit
    vi.stubEnv("APP_BASE_URL", "");
    await grab(known.email);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(responses[0].body).toContain("Der Link gilt 30 Minuten.");
  });

  it("Mail geht erst nach der Antwort raus; Host-Header aendert den Link nicht", async () => {
    const u = await makeUser();
    const r = await request(req("/api/auth/password-reset/request", { email: u.email }, { host: "evil.example" }));
    expect(r.status).toBe(200);
    expect(hoisted.memory!.sent).toHaveLength(0);
    await flush();
    expect(hoisted.memory!.sent).toHaveLength(1);
    const m = hoisted.memory!.sent[0];
    expect(m.to).toEqual([u.email]);
    expect(m.text).toContain("https://rechnung.example.test/login/passwort-zuruecksetzen/");
    expect(m.text).not.toContain("evil.example");
  });

  it("6. Anfrage je IP -> 429 mit Retry-After; ungueltige E-Mail -> 400", async () => {
    const fixed = "198.51.100.200";
    for (let i = 0; i < 5; i++) {
      const r = await request(req("/api/auth/password-reset/request", { email: "a@example.com" }, { "x-forwarded-for": fixed }));
      expect(r.status).toBe(200);
    }
    const blocked = await request(req("/api/auth/password-reset/request", { email: "a@example.com" }, { "x-forwarded-for": fixed }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const bad = await request(req("/api/auth/password-reset/request", { email: "keine-mail" }));
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/auth/password-reset/confirm", () => {
  async function tokenFor(email: string): Promise<string> {
    await request(req("/api/auth/password-reset/request", { email }));
    await flush();
    const m = hoisted.memory!.sent.at(-1)!;
    return m.text.match(/passwort-zuruecksetzen\/([A-Za-z0-9_-]{43})/)![1];
  }
  const body = (token: string, extra: Record<string, unknown> = {}) => ({ token, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD, ...extra });

  it("ok -> 200; zweites Einloesen -> 400 ungueltig", async () => {
    const u = await makeUser();
    const t = await tokenFor(u.email);
    expect((await confirm(req("/api/auth/password-reset/confirm", body(t)))).status).toBe(200);
    const again = await confirm(req("/api/auth/password-reset/confirm", body(t)));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "Der Link ist ungültig oder abgelaufen." });
  });

  it("2FA ohne Code -> 400 secondFactorRequired; falscher Code -> 401; richtiger Code -> 200", async () => {
    const u = await makeUser();
    const setup = await beginTotpSetup(u.id, { issuer: "T" });
    const secret = base32Decode(setup.secret);
    const en = await enableTotp(u.id, { password: PASSWORD, code: hotp(secret, totpStep(new Date())) });
    expect(en.status).toBe("ok");
    const t = await tokenFor(u.email);
    const noCode = await confirm(req("/api/auth/password-reset/confirm", body(t)));
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toMatchObject({ secondFactorRequired: true });
    expect((await confirm(req("/api/auth/password-reset/confirm", body(t, { code: "000000" })))).status).toBe(401);
    // Naechster Schritt (der aktuelle wurde bei der Einrichtung verbraucht).
    const next = hotp(secret, totpStep(new Date()) + 1);
    expect((await confirm(req("/api/auth/password-reset/confirm", body(t, { code: next })))).status).toBe(200);
  });

  it("6. Anfrage je IP -> 429", async () => {
    const fixed = "198.51.100.201";
    for (let i = 0; i < 5; i++) {
      const r = await confirm(req("/api/auth/password-reset/confirm", body("A".repeat(43)), { "x-forwarded-for": fixed }));
      expect(r.status).toBe(400);
    }
    const blocked = await confirm(req("/api/auth/password-reset/confirm", body("A".repeat(43)), { "x-forwarded-for": fixed }));
    expect(blocked.status).toBe(429);
  });
});
