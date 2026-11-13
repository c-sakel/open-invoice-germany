/**
 * Phase 17d, Task 3 — Domaene der Zwei-Faktor-Anmeldung (src/domain/auth/two-factor.ts,
 * attempts.ts, login.ts): Einrichten, Abschalten, zweiter Faktor, Replay-Schutz, Sperre.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { resetRateLimits, RateLimitError } from "@/lib/rate-limit";
import { base32Decode, hotp, totpStep } from "@/lib/auth/totp";
import { decryptSecret } from "@/lib/crypto/secrets";
import { createApiKey } from "@/domain/api-key/create";
import { attemptLogin } from "@/domain/auth/login";
import {
  TOTP_SECRET_PURPOSE,
  TotpAlreadyEnabledError,
  accountSecurityStatus,
  beginTotpSetup,
  disableTotp,
  enableTotp,
  renewRecoveryCodes,
  verifySecondFactor,
} from "@/domain/auth/two-factor";

const PASSWORD = "richtiges-passwort-123";
const T0 = new Date("2030-05-05T10:00:00.000Z");
const STEP_MS = 30_000;
let counter = 0;
let orgId = "";

function at(steps: number): Date {
  return new Date(T0.getTime() + steps * STEP_MS);
}
function code(secret: Buffer, now: Date, offset = 0): string {
  return hotp(secret, totpStep(now) + offset);
}

async function makeUser() {
  counter += 1;
  const email = `two-factor-${counter}@example.com`;
  const u = await dbInternal.user.create({ data: { email, passwordHash: hashPassword(PASSWORD) } });
  return { id: u.id, email };
}

/** Konto mit aktiver 2FA (aktiviert zum Zeitpunkt T0). */
async function makeActive() {
  const u = await makeUser();
  const setup = await beginTotpSetup(u.id, { issuer: "Test" });
  const secret = base32Decode(setup.secret);
  const res = await enableTotp(u.id, { code: code(secret, T0) }, { now: T0 });
  if (res.status !== "ok") throw new Error("Einrichtung fehlgeschlagen");
  return { ...u, secret, recoveryCodes: res.recoveryCodes };
}

async function pendingFor(id: string) {
  const u = await dbInternal.user.findUniqueOrThrow({ where: { id }, select: { passwordChangedAt: true } });
  return { uid: id, pwc: u.passwordChangedAt?.getTime() ?? null };
}

async function row(id: string) {
  return dbInternal.user.findUniqueOrThrow({
    where: { id },
    select: { failedLoginCount: true, lockedUntil: true, lastLoginAt: true, totpEnabledAt: true, totpSecretEnc: true, totpLastStep: true },
  });
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Zwei-Faktor Test GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
    select: { id: true },
  });
  orgId = org.id;
});

beforeEach(() => resetRateLimits());

describe("Einrichten", () => {
  it("speichert verschluesselt, QR und URI, ersetzt Geheimnis, sperrt bei aktiver 2FA", async () => {
    const u = await makeUser();
    const a = await beginTotpSetup(u.id, { issuer: "Meine Rechnung" });
    const r1 = await row(u.id);
    expect(r1.totpEnabledAt).toBeNull();
    expect(r1.totpSecretEnc!.startsWith("v1:")).toBe(true);
    expect(r1.totpSecretEnc).not.toContain(a.secret);
    expect(decryptSecret(r1.totpSecretEnc!, TOTP_SECRET_PURPOSE)).toBe(a.secret);
    expect(a.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(a.otpauthUri).toContain("issuer=Meine%20Rechnung");
    expect(a.otpauthUri).toContain(encodeURIComponent(u.email));

    const b = await beginTotpSetup(u.id, { issuer: "X" });
    expect(b.secret).not.toBe(a.secret);
    expect(decryptSecret((await row(u.id)).totpSecretEnc!, TOTP_SECRET_PURPOSE)).toBe(b.secret);

    await enableTotp(u.id, { code: hotp(base32Decode(b.secret), totpStep(T0)) }, { now: T0 });
    await expect(beginTotpSetup(u.id)).rejects.toBeInstanceOf(TotpAlreadyEnabledError);
  });

  it("enableTotp: falscher Code, ohne Einrichtung, richtiger Code, Replay", async () => {
    const u = await makeUser();
    expect((await enableTotp(u.id, { code: "123456" }, { now: T0 })).status).toBe("no_pending_setup");
    const setup = await beginTotpSetup(u.id, { issuer: "T" });
    const secret = base32Decode(setup.secret);
    const wrong = code(secret, T0) === "000000" ? "000001" : "000000";
    expect((await enableTotp(u.id, { code: wrong }, { now: T0 })).status).toBe("invalid_code");
    expect((await row(u.id)).totpEnabledAt).toBeNull();

    const res = await enableTotp(u.id, { code: code(secret, T0) }, { now: T0 });
    if (res.status !== "ok") throw new Error("erwartet ok");
    expect(res.recoveryCodes).toHaveLength(10);
    const r = await row(u.id);
    expect(r.totpEnabledAt?.getTime()).toBe(T0.getTime());
    expect(r.totpLastStep).toBe(totpStep(T0));
    const rows = await dbInternal.recoveryCode.findMany({ where: { userId: u.id }, select: { codeHash: true } });
    expect(rows).toHaveLength(10);
    for (const c of res.recoveryCodes) for (const x of rows) expect(x.codeHash).not.toContain(c.replace("-", ""));

    const pending = await pendingFor(u.id);
    expect((await verifySecondFactor(pending, { code: code(secret, T0) }, { now: T0 })).status).toBe("invalid");
  });
});

describe("attemptLogin mit 2FA", () => {
  it("richtiges Passwort -> second_factor, Zaehler und lastLoginAt unveraendert", async () => {
    const u = await makeActive();
    await dbInternal.user.update({ where: { id: u.id }, data: { failedLoginCount: 3 } });
    const res = await attemptLogin({ email: u.email, password: PASSWORD }, { now: T0 });
    expect(res).toEqual({ status: "second_factor", userId: u.id });
    const r = await row(u.id);
    expect(r.failedLoginCount).toBe(3);
    expect(r.lastLoginAt).toBeNull();
  });
  it("ohne 2FA wie bisher", async () => {
    const u = await makeUser();
    await dbInternal.user.update({ where: { id: u.id }, data: { failedLoginCount: 3 } });
    expect((await attemptLogin({ email: u.email, password: PASSWORD }, { now: T0 })).status).toBe("ok");
    expect((await row(u.id)).failedLoginCount).toBe(0);
  });
});

describe("verifySecondFactor", () => {
  it("Fensterschritte s-1, s, s+1 je einmal; danach Zaehler 0 und lastLoginAt", async () => {
    const u = await makeActive();
    await dbInternal.user.update({ where: { id: u.id }, data: { failedLoginCount: 2 } });
    const pending = await pendingFor(u.id);
    const now = at(10);
    for (const off of [-1, 0, 1]) {
      expect((await verifySecondFactor(pending, { code: code(u.secret, now, off) }, { now })).status).toBe("ok");
    }
    const r = await row(u.id);
    expect(r.failedLoginCount).toBe(0);
    expect(r.lockedUntil).toBeNull();
    expect(r.lastLoginAt?.getTime()).toBe(now.getTime());
  });

  it("gleicher Code zweimal, und parallel genau ein ok", async () => {
    const u = await makeActive();
    const pending = await pendingFor(u.id);
    const now = at(10);
    const c = code(u.secret, now);
    expect((await verifySecondFactor(pending, { code: c }, { now })).status).toBe("ok");
    expect((await verifySecondFactor(pending, { code: c }, { now })).status).toBe("invalid");

    const p2 = await makeActive();
    const pend2 = await pendingFor(p2.id);
    const c2 = code(p2.secret, now);
    const results = await Promise.all([
      verifySecondFactor(pend2, { code: c2 }, { now }),
      verifySecondFactor(pend2, { code: c2 }, { now }),
    ]);
    expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
  });

  it("fuenf falsche Codes sperren, danach locked, abgelaufene Sperre zaehlt als erster Fehlversuch", async () => {
    const u = await makeActive();
    const pending = await pendingFor(u.id);
    const now = at(10);
    const wrong = code(u.secret, now, 0) === "000000" ? "000001" : "000000";
    const wrongOk = code(u.secret, now, -1) === wrong || code(u.secret, now, 1) === wrong ? "999999" : wrong;
    for (let i = 0; i < 5; i++) {
      expect((await verifySecondFactor(pending, { code: wrongOk }, { now, ip: "198.51.100.10" })).status).toBe("invalid");
    }
    const r = await row(u.id);
    expect(r.failedLoginCount).toBe(5);
    expect(r.lockedUntil?.getTime()).toBe(now.getTime() + 15 * 60_000);
    const events = await dbInternal.activityLog.findMany({ where: { entityId: u.id }, select: { type: true, dataJson: true } });
    expect(events.filter((e) => e.type === "LOGIN_FAILED")).toHaveLength(5);
    expect(events.some((e) => e.type === "LOGIN_LOCKED")).toBe(true);
    expect(events.some((e) => e.dataJson?.includes("falscher Code (zweiter Faktor)"))).toBe(true);

    const good = code(u.secret, now);
    const locked = await verifySecondFactor(pending, { code: good }, { now, ip: "198.51.100.10" });
    // Kein Orakel: richtiger, falscher und Wiederherstellungscode liefern in der Sperre dieselbe Antwort.
    expect(locked.status).toBe("locked");
    const lockedWrong = await verifySecondFactor(pending, { code: wrongOk }, { now });
    const lockedRecovery = await verifySecondFactor(pending, { code: u.recoveryCodes[0]! }, { now });
    expect(lockedWrong).toEqual(locked);
    expect(lockedRecovery).toEqual(locked);
    expect((await dbInternal.recoveryCode.count({ where: { userId: u.id, usedAt: null } }))).toBe(10);
    const r2 = await row(u.id);
    expect(r2.failedLoginCount).toBe(5);
    expect(r2.lockedUntil?.getTime()).toBe(r.lockedUntil?.getTime());
    expect(r2.totpLastStep).toBe(totpStep(T0));

    // Sperre abgelaufen: ein Fehlversuch zaehlt als erster.
    const later = new Date(now.getTime() + 16 * 60_000);
    await verifySecondFactor(pending, { code: wrongOk }, { now: later });
    expect((await row(u.id)).failedLoginCount).toBe(1);
  });

  it("geaendertes Passwort (pwc) oder abgeschaltete 2FA -> expired", async () => {
    const u = await makeActive();
    const pending = await pendingFor(u.id);
    const now = at(10);
    expect((await verifySecondFactor({ ...pending, pwc: 123 }, { code: code(u.secret, now) }, { now })).status).toBe("expired");
    await dbInternal.user.update({ where: { id: u.id }, data: { totpEnabledAt: null } });
    expect((await verifySecondFactor(pending, { code: code(u.secret, now) }, { now })).status).toBe("expired");
  });

  it("Wiederherstellungscode: klein mit Leerzeichen, einmalig, zaehlt als Fehlversuch, fremder Code ungueltig", async () => {
    const u = await makeActive();
    const other = await makeActive();
    const pending = await pendingFor(u.id);
    const now = at(10);
    const rc = u.recoveryCodes[0]!;
    const typed = ` ${rc.slice(0, 5).toLowerCase()} ${rc.slice(6).toLowerCase()} `;
    expect((await verifySecondFactor(pending, { code: typed }, { now })).status).toBe("ok");
    const used = await dbInternal.activityLog.findMany({ where: { entityId: u.id, type: "RECOVERY_CODE_USED" }, select: { dataJson: true } });
    expect(JSON.parse(used[0]!.dataJson!)).toMatchObject({ remaining: 9 });

    expect((await verifySecondFactor(pending, { code: rc }, { now })).status).toBe("invalid");
    expect((await row(u.id)).failedLoginCount).toBe(1);
    expect((await verifySecondFactor(pending, { code: other.recoveryCodes[0]! }, { now })).status).toBe("invalid");
  });

  it("IP-Bremse gemischt: der 11. Aufruf wirft RateLimitError", async () => {
    const u = await makeActive();
    const pending = await pendingFor(u.id);
    const now = at(10);
    const ip = "198.51.100.20";
    for (let i = 0; i < 5; i++) await attemptLogin({ email: u.email, password: "falsch" }, { ip, now });
    // Konto ist gesperrt; die Bremse zaehlt trotzdem je Aufruf.
    for (let i = 0; i < 5; i++) await verifySecondFactor(pending, { code: "000000" }, { ip, now });
    await expect(verifySecondFactor(pending, { code: "000000" }, { ip, now })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("disableTotp und renewRecoveryCodes", () => {
  it("falsches Passwort / falscher Code -> invalid + Fehlversuch; richtig -> abgeschaltet", async () => {
    const u = await makeActive();
    const other = await makeActive();
    const now = at(10);
    expect((await disableTotp(u.id, { password: "falsch", code: code(u.secret, now) }, { now })).status).toBe("invalid");
    expect((await row(u.id)).failedLoginCount).toBe(1);
    expect((await row(u.id)).totpLastStep).toBe(totpStep(T0)); // Code bei falschem Passwort nicht verbraucht
    expect((await disableTotp(u.id, { password: PASSWORD, code: "000000" }, { now })).status).toBe("invalid");
    expect((await row(u.id)).failedLoginCount).toBe(2);

    expect((await disableTotp(u.id, { password: PASSWORD, code: code(u.secret, now) }, { now })).status).toBe("ok");
    const r = await row(u.id);
    expect(r).toMatchObject({ totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null, failedLoginCount: 0 });
    expect(await dbInternal.recoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect(await dbInternal.activityLog.count({ where: { entityId: u.id, type: "TOTP_DISABLED" } })).toBe(1);
    expect((await row(other.id)).totpEnabledAt).not.toBeNull();
    expect(await dbInternal.recoveryCode.count({ where: { userId: other.id } })).toBe(10);
  });

  it("Abschalten mit Wiederherstellungscode", async () => {
    const u = await makeActive();
    expect((await disableTotp(u.id, { password: PASSWORD, code: u.recoveryCodes[3]! }, { now: at(10) })).status).toBe("ok");
    expect((await row(u.id)).totpEnabledAt).toBeNull();
  });

  it("renewRecoveryCodes: alte ungueltig, zehn neue, Protokoll", async () => {
    const u = await makeActive();
    const now = at(10);
    const res = await renewRecoveryCodes(u.id, { password: PASSWORD, code: code(u.secret, now) }, { now });
    if (res.status !== "ok") throw new Error("erwartet ok");
    expect(res.recoveryCodes).toHaveLength(10);
    const st = await accountSecurityStatus(u.id);
    expect(st.recoveryCodesRemaining).toBe(10);
    const pending = await pendingFor(u.id);
    expect((await verifySecondFactor(pending, { code: u.recoveryCodes[0]! }, { now: at(12) })).status).toBe("invalid");
    expect((await verifySecondFactor(pending, { code: res.recoveryCodes[0]! }, { now: at(12) })).status).toBe("ok");
    expect(await dbInternal.activityLog.count({ where: { entityId: u.id, type: "RECOVERY_CODES_RENEWED" } })).toBe(1);
  });
});

describe("Protokoll und API-Schluessel", () => {
  it("kein dataJson enthaelt E-Mail, Passwort, Code oder Geheimnis", async () => {
    const u = await makeActive();
    const pending = await pendingFor(u.id);
    const now = at(10);
    await verifySecondFactor(pending, { code: "000000" }, { now });
    await verifySecondFactor(pending, { code: u.recoveryCodes[0]! }, { now });
    await disableTotp(u.id, { password: "falsch", code: u.recoveryCodes[1]! }, { now });
    const secretB32 = decryptSecret((await row(u.id)).totpSecretEnc!, TOTP_SECRET_PURPOSE);
    const logs = await dbInternal.activityLog.findMany({ where: { entityId: u.id }, select: { dataJson: true } });
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.map((l) => l.dataJson ?? "").join("\n");
    for (const needle of [u.email, PASSWORD, secretB32, u.recoveryCodes[0]!, u.recoveryCodes[0]!.replace("-", ""), "000000"]) {
      expect(all).not.toContain(needle);
    }
  });

  it("API-Schluessel bleiben beim Einrichten unberuehrt", async () => {
    const u = await makeUser();
    const key = await createApiKey(orgId, { name: "2fa-test", scopes: ["read"] });
    const before = await dbInternal.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { revokedAt: true, keyHash: true } });
    const setup = await beginTotpSetup(u.id, { issuer: "T" });
    await enableTotp(u.id, { code: code(base32Decode(setup.secret), T0) }, { now: T0 });
    const after = await dbInternal.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { revokedAt: true, keyHash: true } });
    expect(after).toEqual(before);
    expect(after.revokedAt).toBeNull();
  });
});
