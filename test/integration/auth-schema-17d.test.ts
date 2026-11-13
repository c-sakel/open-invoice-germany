/**
 * Phase 17d, Task 1 — Schema fuer TOTP-Spalten, RecoveryCode und PasswordResetToken.
 * Eigene E-Mail-Praefixe d17t1-<lfd>@example.com; Aufraeumen ueber User-Loeschung (Cascade).
 */
import { describe, it, expect, afterAll } from "vitest";
import { dbInternal } from "@/lib/db";

const emails = ["d17t1-1@example.com", "d17t1-2@example.com"];

async function makeUser(email: string) {
  return dbInternal.user.create({
    data: { email, passwordHash: "x:y" },
    select: { id: true, totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true },
  });
}

describe("Phase 17d Schema", () => {
  afterAll(async () => {
    await dbInternal.user.deleteMany({ where: { email: { in: emails } } });
  });

  it("Bestands-User ohne neue Felder: TOTP-Spalten sind null", async () => {
    const u = await makeUser(emails[0]!);
    expect(u.totpSecretEnc).toBeNull();
    expect(u.totpEnabledAt).toBeNull();
    expect(u.totpLastStep).toBeNull();
  });

  it("totpLastStep nimmt den RFC-Vektor-Schritt auf", async () => {
    const u = await dbInternal.user.findUniqueOrThrow({ where: { email: emails[0]! }, select: { id: true } });
    const upd = await dbInternal.user.update({
      where: { id: u.id },
      data: { totpLastStep: 66_666_666 },
      select: { totpLastStep: true },
    });
    expect(upd.totpLastStep).toBe(66_666_666);
  });

  it("RecoveryCode: (userId, codeHash) eindeutig, gleicher Hash bei anderem User erlaubt", async () => {
    const a = await dbInternal.user.findUniqueOrThrow({ where: { email: emails[0]! }, select: { id: true } });
    const b = await makeUser(emails[1]!);
    await dbInternal.recoveryCode.create({ data: { userId: a.id, codeHash: "h1" }, select: { id: true } });
    await expect(
      dbInternal.recoveryCode.create({ data: { userId: a.id, codeHash: "h1" }, select: { id: true } }),
    ).rejects.toThrow();
    await expect(
      dbInternal.recoveryCode.create({ data: { userId: b.id, codeHash: "h1" }, select: { id: true } }),
    ).resolves.toBeTruthy();
  });

  it("PasswordResetToken: tokenHash eindeutig", async () => {
    const a = await dbInternal.user.findUniqueOrThrow({ where: { email: emails[0]! }, select: { id: true } });
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    await dbInternal.passwordResetToken.create({ data: { userId: a.id, tokenHash: "t1", expiresAt }, select: { id: true } });
    await expect(
      dbInternal.passwordResetToken.create({ data: { userId: a.id, tokenHash: "t1", expiresAt }, select: { id: true } }),
    ).rejects.toThrow();
  });

  it("Kindzeilen folgen dem User per Cascade", async () => {
    const a = await dbInternal.user.findUniqueOrThrow({ where: { email: emails[0]! }, select: { id: true } });
    await dbInternal.user.delete({ where: { id: a.id }, select: { id: true } });
    expect(await dbInternal.recoveryCode.count({ where: { userId: a.id } })).toBe(0);
    expect(await dbInternal.passwordResetToken.count({ where: { userId: a.id } })).toBe(0);
  });
});
