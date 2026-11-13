/**
 * Phase 17d, Task 6 — Notfallskript scripts/disable-2fa.sh (SQLite-Testdatenbank).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { createSessionToken } from "@/lib/auth/session";
import { userIdFromToken } from "@/lib/auth/server";
import { hashPassword } from "@/lib/auth/password";

const DB_URL = "file:" + path.resolve("prisma/test.db");
const SCRIPT = "scripts/disable-2fa.sh";
const LOCK_UNTIL = new Date("2099-01-01T00:00:00.000Z");
let counter = 0;

function run(args: string[], env: Record<string, string | undefined> = { DATABASE_URL: DB_URL }) {
  const merged: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: undefined, ...env };
  return spawnSync("sh", [SCRIPT, ...args], { env: merged, encoding: "utf8", timeout: 60_000 });
}

async function makeUser(withTotp = true) {
  counter += 1;
  const email = `disable-2fa-${counter}@example.com`;
  const u = await dbInternal.user.create({
    data: {
      email,
      passwordHash: hashPassword("irgendein-passwort-1"),
      ...(withTotp ? { totpSecretEnc: "v1:geheim", totpEnabledAt: new Date("2030-01-01T00:00:00Z"), totpLastStep: 42 } : {}),
      failedLoginCount: 5,
      lockedUntil: LOCK_UNTIL,
    },
    select: { id: true },
  });
  if (withTotp) {
    await dbInternal.recoveryCode.createMany({ data: [{ userId: u.id, codeHash: `h1-${u.id}` }, { userId: u.id, codeHash: `h2-${u.id}` }] });
  }
  return { id: u.id, email };
}

async function state(id: string) {
  const u = await dbInternal.user.findUniqueOrThrow({
    where: { id },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true, failedLoginCount: true, lockedUntil: true, passwordChangedAt: true },
  });
  return { ...u, passwordChangedAt: u.passwordChangedAt === null ? null : "gesetzt", codes: await dbInternal.recoveryCode.count({ where: { userId: id } }) };
}


describe("scripts/disable-2fa.sh", () => {
  it("--email: nur dieses Konto wird zurueckgesetzt", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const r = run(["--bestaetigen", "--email", a.email]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("abgeschaltet");
    expect(await state(a.id)).toEqual({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: "gesetzt", codes: 0 });
    const sb = await state(b.id);
    expect(sb.totpSecretEnc).toBe("v1:geheim");
    expect(sb.failedLoginCount).toBe(5);
    expect(sb.codes).toBe(2);
  });

  it("beendet bestehende Sitzungen (passwordChangedAt wird neu gesetzt, Token mit altem pwc ungueltig)", async () => {
    const a = await makeUser();
    const old = await createSessionToken(a.id, null);
    expect(await userIdFromToken(old)).toBe(a.id);
    await dbInternal.passwordResetToken.create({
      data: { userId: a.id, tokenHash: `skript-${a.id}`, expiresAt: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    expect(run(["--bestaetigen", "--email", a.email]).status).toBe(0);
    expect(await dbInternal.passwordResetToken.count({ where: { userId: a.id, usedAt: null } })).toBe(0);
    expect(await userIdFromToken(old)).toBeNull();
    const row = await dbInternal.user.findUniqueOrThrow({ where: { id: a.id }, select: { passwordChangedAt: true } });
    expect(Math.abs(row.passwordChangedAt!.getTime() - Date.now())).toBeLessThan(5 * 60_000);
    expect(await userIdFromToken(await createSessionToken(a.id, row.passwordChangedAt!.getTime()))).toBe(a.id);
  });

  it("ohne --email: alle Konten", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const r = run(["--bestaetigen"]);
    expect(r.status).toBe(0);
    for (const u of [a, b]) {
      expect(await state(u.id)).toEqual({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: "gesetzt", codes: 0 });
    }
  });

  it("gueltige, aber unbekannte E-Mail: Exit 1, klare Meldung, nichts geaendert", async () => {
    const a = await makeUser();
    const r = run(["--bestaetigen", "--email", "gibt-es-nicht@example.com"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Kein Konto gefunden");
    expect(r.stdout).not.toContain("abgeschaltet");
    const sa = await state(a.id);
    expect(sa.totpSecretEnc).toBe("v1:geheim");
    expect(sa.failedLoginCount).toBe(5);
    expect(sa.codes).toBe(2);
  });

  it("ohne --bestaetigen oder ohne DATABASE_URL: Exit 2, nichts geaendert", async () => {
    const a = await makeUser();
    expect(run([]).status).toBe(2);
    expect(run(["--email", a.email]).status).toBe(2);
    expect(run(["--bestaetigen", "--email", a.email], {}).status).toBe(2);
    expect((await state(a.id)).totpSecretEnc).toBe("v1:geheim");
  });

  it.each([["a'b@example.com"], ["a@example.com\n; DELETE FROM \"User\""], ["kein-at"], ["a@@example.com"], ["@example.com"], ["a@"], ["a b@example.com"], [""]])(
    "ungueltige E-Mail %j: Exit 2, nichts geaendert",
    async (bad) => {
      const a = await makeUser();
      const r = run(["--bestaetigen", "--email", bad]);
      expect(r.status).toBe(2);
      expect((await state(a.id)).totpSecretEnc).toBe("v1:geheim");
      expect(await dbInternal.user.count()).toBeGreaterThan(0);
    },
  );

  it("ist im Image enthalten: Dockerfile-COPY und .dockerignore", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const copy = dockerfile.split("\n").find((l) => l.includes("scripts/docker-entrypoint.sh"));
    expect(copy).toBeDefined();
    expect(dockerfile).toMatch(/\/app\/scripts\/disable-2fa\.sh/);
    expect(readFileSync(".dockerignore", "utf8").split("\n")).toContain("!scripts/disable-2fa.sh");
  });
});
