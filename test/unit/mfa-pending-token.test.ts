import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPendingMfaToken, verifyPendingMfaToken, createSessionToken, verifySessionToken } from "@/lib/auth/session";

describe("Zwischen-Token des zweiten Faktors", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-secret-17d-0123456789abcdef"));
  afterEach(() => vi.unstubAllEnvs());

  it("Rundreise { uid, pwc }", async () => {
    const t = await createPendingMfaToken("u1", 1234);
    expect(await verifyPendingMfaToken(t)).toEqual({ uid: "u1", pwc: 1234 });
    const t2 = await createPendingMfaToken("u2", null);
    expect(await verifyPendingMfaToken(t2)).toEqual({ uid: "u2", pwc: null });
  });
  it("laeuft nach 300 s ab", async () => {
    const now = Date.now();
    const t = await createPendingMfaToken("u1", null, now);
    expect(await verifyPendingMfaToken(t, now + 299_000)).not.toBeNull();
    expect(await verifyPendingMfaToken(t, now + 301_000)).toBeNull();
  });
  it("manipulierte Signatur/Payload -> null", async () => {
    const t = await createPendingMfaToken("u1", null);
    const [p, s] = t.split(".");
    expect(await verifyPendingMfaToken(`${p}.${s!.slice(0, -2)}AA`)).toBeNull();
    const other = await createPendingMfaToken("u2", null);
    expect(await verifyPendingMfaToken(`${other.split(".")[0]}.${s}`)).toBeNull();
    expect(await verifyPendingMfaToken("")).toBeNull();
    expect(await verifyPendingMfaToken(null)).toBeNull();
  });
  it("Zwischen-Token ist keine Sitzung", async () => {
    expect(await verifySessionToken(await createPendingMfaToken("u1", null))).toBeNull();
  });
  it("Sitzungs-Token ist kein Zwischen-Token", async () => {
    expect(await verifyPendingMfaToken(await createSessionToken("u1", null))).toBeNull();
  });
  it("Sitzungs-Token ohne typ bleibt gueltig", async () => {
    expect(await verifySessionToken(await createSessionToken("u1", 5))).toEqual({ uid: "u1", pwc: 5 });
  });
});
