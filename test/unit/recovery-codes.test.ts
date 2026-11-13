import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/lib/auth/recovery-codes";
import { SecretsUnavailableError } from "@/lib/crypto/secrets";

describe("Wiederherstellungscodes", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-secret-17d-0123456789abcdef"));
  afterEach(() => vi.unstubAllEnvs());

  it("zehn Codes, Format, paarweise verschieden", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("normalisieren", () => {
    expect(normalizeRecoveryCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("ABCDE-FGHJO")).toBeNull();
    expect(normalizeRecoveryCode("ABCDE-FGHJ0")).toBeNull();
    expect(normalizeRecoveryCode("ABCDE-FGHJ1")).toBeNull();
    expect(normalizeRecoveryCode("ABCDE-FGHJI")).toBeNull();
    expect(normalizeRecoveryCode("ABCDEFGHJ")).toBeNull();
    expect(normalizeRecoveryCode("ABCDEFGHJKL")).toBeNull();
  });
  it("Hash: deterministisch, 64 Hex, secret-abhaengig, ohne Klartext", () => {
    const h = hashRecoveryCode("ABCDEFGHJK");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode("ABCDEFGHJK")).toBe(h);
    expect(h).not.toContain("ABCDEFGHJK");
    vi.stubEnv("AUTH_SECRET", "anderes-secret-17d-0123456789abcdef");
    expect(hashRecoveryCode("ABCDEFGHJK")).not.toBe(h);
  });
  it("ohne AUTH_SECRET: SecretsUnavailableError", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => hashRecoveryCode("ABCDEFGHJK")).toThrow(SecretsUnavailableError);
  });
});
