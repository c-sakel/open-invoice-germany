import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";

describe("AUTH_SECRET-Pflicht in Produktion", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ohne AUTH_SECRET wirft createSessionToken in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "");
    await expect(createSessionToken("u1", null)).rejects.toThrow(/AUTH_SECRET/);
  });
  it("mit AUTH_SECRET funktioniert production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "x".repeat(32));
    await expect(createSessionToken("u1", null)).resolves.toEqual(expect.any(String));
  });
  it("ausserhalb von production bleibt der Dev-Fallback", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_SECRET", "");
    await expect(createSessionToken("u1", null)).resolves.toEqual(expect.any(String));
  });
});
