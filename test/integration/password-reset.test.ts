/**
 * Phase 17d, Task 5 — Domaene des Passwort-Resets (src/domain/auth/password-reset.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { resetRateLimits, RateLimitError } from "@/lib/rate-limit";
import { base32Decode, hotp, totpStep } from "@/lib/auth/totp";
import { createMemoryProvider } from "@/lib/mail/memory";
import { createSessionToken } from "@/lib/auth/session";
import { userIdFromToken } from "@/lib/auth/server";
import { saveMailSettings } from "@/domain/email/settings";
import { createApiKey } from "@/domain/api-key/create";
import { beginTotpSetup, enableTotp } from "@/domain/auth/two-factor";
import {
  confirmPasswordReset,
  deliverPasswordResetMail,
  hashResetToken,
  inspectResetToken,
  passwordResetAvailability,
  requestPasswordReset,
} from "@/domain/auth/password-reset";

const PASSWORD = "richtiges-passwort-123";
const NEW_PASSWORD = "ein-ganz-neues-passwort-1";
const BASE = "https://rechnung.example.test";
const T0 = new Date("2031-06-06T10:00:00.000Z");
const MIN = 60_000;
let counter = 0;
let orgId = "";
let orgNoMailId = "";

function min(n: number): Date {
  return new Date(T0.getTime() + n * MIN);
}

async function makeUser() {
  counter += 1;
  const email = `pw-reset-${counter}@example.com`;
  const u = await dbInternal.user.create({ data: { email, passwordHash: hashPassword(PASSWORD) } });
  return { id: u.id, email };
}

/** Fordert einen Reset an und liefert das Token aus dem Mailtext. */
async function requestToken(email: string, now: Date = T0): Promise<string> {
  const { mail } = await requestPasswordReset({ email }, { now, orgId, ip: `203.0.113.${counter % 200}` });
  if (!mail) throw new Error("keine Mail");
  const m = mail.text.match(/passwort-zuruecksetzen\/([A-Za-z0-9_-]{43})/);
  if (!m) throw new Error("kein Token im Text");
  return m[1];
}

function confirm(token: string, extra: Record<string, unknown> = {}, now: Date = min(1)) {
  return confirmPasswordReset({ token, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD, ...extra }, { now, ip: "203.0.113.250" });
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Reset Test GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
    select: { id: true },
  });
  orgId = org.id;
  await saveMailSettings(orgId, {
    host: "smtp.example.test",
    port: 587,
    security: "STARTTLS",
    username: "u",
    password: "p",
    fromName: "Reset Test",
    fromEmail: "absender@example.test",
    defaultCc: "cc@example.test",
    defaultBcc: "bcc@example.test",
    copyToSelf: true,
  });
  const other = await dbInternal.organization.create({
    data: { legalName: "Ohne Mail GmbH", addressLine1: "Weg 2", postalCode: "10115", city: "Berlin" },
    select: { id: true },
  });
  orgNoMailId = other.id;
});

beforeEach(() => {
  resetRateLimits();
  vi.stubEnv("APP_BASE_URL", BASE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("requestPasswordReset", () => {
  it("bekannte E-Mail: Mail mit Link, nur Hash in der DB, Versand ohne CC/BCC und ohne EmailLog", async () => {
    const u = await makeUser();
    const logsBefore = await dbInternal.emailLog.count();
    const { mail } = await requestPasswordReset({ email: u.email }, { now: T0, orgId, ip: "203.0.113.1" });
    expect(mail).not.toBeNull();
    expect(mail!.to).toBe(u.email);
    expect(mail!.text).toContain("30 Minuten");
    const token = mail!.text.match(new RegExp(`${BASE}/login/passwort-zuruecksetzen/([A-Za-z0-9_-]{43})`))?.[1];
    expect(token).toBeDefined();

    const rows = await dbInternal.passwordResetToken.findMany({ where: { userId: u.id }, select: { tokenHash: true, expiresAt: true, usedAt: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].tokenHash).toBe(hashResetToken(token!));
    expect(rows[0].expiresAt.getTime()).toBe(T0.getTime() + 30 * MIN);

    const provider = createMemoryProvider();
    await deliverPasswordResetMail(mail!, provider);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toEqual([u.email]);
    expect(provider.sent[0].cc).toEqual([]);
    expect(provider.sent[0].bcc).toEqual([]);
    expect(await dbInternal.emailLog.count()).toBe(logsBefore);

    const logs = await dbInternal.activityLog.findMany({ where: { entityId: u.id, type: "PASSWORD_RESET_REQUESTED" }, select: { dataJson: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0].dataJson).not.toContain(u.email);
    expect(logs[0].dataJson).not.toContain(token!);
  });

  it("unbekannte E-Mail: keine Mail, keine Zeile", async () => {
    const before = await dbInternal.passwordResetToken.count();
    const { mail } = await requestPasswordReset({ email: "gibt-es-nicht@example.com" }, { now: T0, orgId, ip: "203.0.113.2" });
    expect(mail).toBeNull();
    expect(await dbInternal.passwordResetToken.count()).toBe(before);
  });

  it("ohne MailSettings bzw. APP_BASE_URL: keine Mail, keine Zeile, eine Warnung ohne Adresse", async () => {
    const u = await makeUser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await requestPasswordReset({ email: u.email }, { now: T0, orgId: orgNoMailId, ip: "203.0.113.3" });
    expect(a.mail).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(u.email);
    expect((await passwordResetAvailability(orgNoMailId))).toEqual({ available: false, reason: "smtp" });

    vi.stubEnv("APP_BASE_URL", "");
    const b = await requestPasswordReset({ email: u.email }, { now: T0, orgId, ip: "203.0.113.3" });
    expect(b.mail).toBeNull();
    expect(await passwordResetAvailability(orgId)).toEqual({ available: false, reason: "base-url" });
    expect(await dbInternal.passwordResetToken.count({ where: { userId: u.id } })).toBe(0);
  });

  it("zweite Anforderung entwertet die erste; 4. je Stunde liefert nichts; nach 61 min wieder moeglich", async () => {
    const u = await makeUser();
    const t1 = await requestToken(u.email, T0);
    const t2 = await requestToken(u.email, min(1));
    expect((await confirm(t1)).status).toBe("invalid_token");
    expect(await inspectResetToken(t2, min(2))).toEqual({ valid: true, requiresSecondFactor: false });
    await requestToken(u.email, min(2));
    const fourth = await requestPasswordReset({ email: u.email }, { now: min(3), orgId, ip: "203.0.113.4" });
    expect(fourth.mail).toBeNull();
    expect(await dbInternal.passwordResetToken.count({ where: { userId: u.id } })).toBe(3);
    const later = await requestPasswordReset({ email: u.email }, { now: min(62), orgId, ip: "203.0.113.4" });
    expect(later.mail).not.toBeNull();
  });

  it("raeumt Token auf, die aelter als 24 Stunden sind", async () => {
    const u = await makeUser();
    await dbInternal.passwordResetToken.create({
      data: { userId: u.id, tokenHash: hashResetToken("alt-" + counter), expiresAt: new Date(T0.getTime() - 25 * 60 * MIN), createdAt: new Date(T0.getTime() - 25 * 60 * MIN) },
      select: { id: true },
    });
    await requestPasswordReset({ email: "irgendwer@example.com" }, { now: T0, orgId, ip: "203.0.113.5" });
    expect(await dbInternal.passwordResetToken.count({ where: { userId: u.id } })).toBe(0);
  });

  it("IP-Bremse: 6. Anforderung in 15 Minuten wirft RateLimitError", async () => {
    for (let i = 0; i < 5; i++) await requestPasswordReset({ email: "x@example.com" }, { now: T0, orgId, ip: "203.0.113.99" });
    await expect(requestPasswordReset({ email: "x@example.com" }, { now: T0, orgId, ip: "203.0.113.99" })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("confirmPasswordReset", () => {
  it("setzt Passwort, beendet Sitzungen, hebt Sperre auf, entwertet Token, laesst API-Schluessel unberuehrt", async () => {
    const u = await makeUser();
    const key = await createApiKey(orgId, { name: "reset-test", scopes: ["read"] });
    await dbInternal.user.update({ where: { id: u.id }, data: { failedLoginCount: 5, lockedUntil: min(10) }, select: { id: true } });
    const oldToken = await createSessionToken(u.id, null);
    const t1 = await requestToken(u.email);
    const t2 = await requestToken(u.email, min(0.5));

    expect((await confirm(t2)).status).toBe("ok");
    const after = await dbInternal.user.findUniqueOrThrow({ where: { id: u.id }, select: { passwordHash: true, passwordChangedAt: true, failedLoginCount: true, lockedUntil: true } });
    expect(verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(after.passwordChangedAt?.getTime()).toBe(min(1).getTime());
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(await userIdFromToken(oldToken)).toBeNull();
    expect(await dbInternal.passwordResetToken.count({ where: { userId: u.id, usedAt: null } })).toBe(0);
    expect((await confirm(t1)).status).toBe("invalid_token");
    expect((await confirm(t2)).status).toBe("invalid_token");

    const logs = await dbInternal.activityLog.findMany({ where: { entityId: u.id, type: "PASSWORD_RESET" }, select: { dataJson: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0].dataJson).not.toContain(NEW_PASSWORD);
    expect(logs[0].dataJson).not.toContain(t2);

    const k = await dbInternal.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { revokedAt: true } });
    expect(k.revokedAt).toBeNull();
  });

  it("abgelaufen nach 30 min + 1 ms, ungueltiges Format und Passwortfehler -> Zod, Token unverbraucht", async () => {
    const u = await makeUser();
    const t = await requestToken(u.email);
    expect((await confirm(t, {}, new Date(T0.getTime() + 30 * MIN + 1))).status).toBe("invalid_token");
    const t2 = await requestToken(u.email, min(40));
    await expect(confirm("kurz")).rejects.toBeInstanceOf(ZodError);
    await expect(confirm(t2, { newPassword: "kurz", newPasswordRepeat: "kurz" })).rejects.toBeInstanceOf(ZodError);
    await expect(confirm(t2, { newPasswordRepeat: "anders-anders-anders" })).rejects.toBeInstanceOf(ZodError);
    expect(await inspectResetToken(t2, min(41))).toMatchObject({ valid: true });
  });

  it("parallel: genau ein Einloesen gewinnt", async () => {
    const u = await makeUser();
    const t = await requestToken(u.email);
    const res = await Promise.all([confirm(t), confirm(t)]);
    expect(res.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(res.filter((r) => r.status === "invalid_token")).toHaveLength(1);
  });

  it("inspectResetToken: gueltig, verbraucht, unbekannt", async () => {
    const u = await makeUser();
    const t = await requestToken(u.email);
    expect(await inspectResetToken(t, min(1))).toEqual({ valid: true, requiresSecondFactor: false });
    await confirm(t);
    expect(await inspectResetToken(t, min(2))).toEqual({ valid: false });
    expect(await inspectResetToken("A".repeat(43), min(2))).toEqual({ valid: false });
  });
});

describe("mit aktiver 2FA", () => {
  async function makeActive() {
    const u = await makeUser();
    const setup = await beginTotpSetup(u.id, { issuer: "T" });
    const secret = base32Decode(setup.secret);
    const res = await enableTotp(u.id, { password: PASSWORD, code: hotp(secret, totpStep(T0)) }, { now: T0 });
    if (res.status !== "ok") throw new Error("Einrichtung fehlgeschlagen");
    return { ...u, secret, recoveryCodes: res.recoveryCodes };
  }

  it("ohne Code: second_factor_required; falscher Code: invalid_code + Fehlversuch, Token bleibt", async () => {
    const u = await makeActive();
    const t = await requestToken(u.email, min(2));
    expect(await inspectResetToken(t, min(3))).toEqual({ valid: true, requiresSecondFactor: true });
    expect((await confirm(t, {}, min(3))).status).toBe("second_factor_required");
    expect((await confirm(t, { code: "000000" }, min(3))).status).toBe("invalid_code");
    const row = await dbInternal.user.findUniqueOrThrow({ where: { id: u.id }, select: { failedLoginCount: true } });
    expect(row.failedLoginCount).toBe(1);
    expect(await inspectResetToken(t, min(3))).toMatchObject({ valid: true });
  });

  it("richtiger TOTP-Code (neuer Schritt) und Wiederherstellungscode: ok, Code verbraucht", async () => {
    const u = await makeActive();
    const t = await requestToken(u.email, min(2));
    const now = min(3);
    expect((await confirm(t, { code: hotp(u.secret, totpStep(now)) }, now)).status).toBe("ok");

    const v = await makeActive();
    const t2 = await requestToken(v.email, min(2));
    expect((await confirm(t2, { code: v.recoveryCodes[0] }, min(3))).status).toBe("ok");
    const used = await dbInternal.recoveryCode.count({ where: { userId: v.id, usedAt: { not: null } } });
    expect(used).toBe(1);
  });

  it("waehrend der Sperre: locked, Passwort unveraendert, Code wird nicht verbraucht", async () => {
    const u = await makeActive();
    const t = await requestToken(u.email, min(2));
    await dbInternal.user.update({ where: { id: u.id }, data: { failedLoginCount: 5, lockedUntil: min(20) }, select: { id: true } });
    const now = min(3);
    const res = await confirm(t, { code: hotp(u.secret, totpStep(now)) }, now);
    expect(res.status).toBe("locked");
    const row = await dbInternal.user.findUniqueOrThrow({ where: { id: u.id }, select: { passwordHash: true } });
    expect(verifyPassword(PASSWORD, row.passwordHash)).toBe(true);
  });
});
