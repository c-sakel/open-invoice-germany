import { describe, expect, it } from "vitest";
import { isSecureRequest } from "@/lib/auth/cookie-secure";

const h = (proto?: string) => new Headers(proto ? { "x-forwarded-proto": proto } : {});

describe("isSecureRequest", () => {
  it("direktes HTTP im LAN (kein Proxy-Header) -> kein Secure, auch bei NODE_ENV=production", () => {
    expect(isSecureRequest(h(), { NODE_ENV: "production" })).toBe(false);
  });
  it("Reverse-Proxy mit https -> Secure", () => {
    expect(isSecureRequest(h("https"), {})).toBe(true);
    expect(isSecureRequest(h("https, http"), {})).toBe(true);
  });
  it("Proxy mit http -> kein Secure", () => {
    expect(isSecureRequest(h("http"), {})).toBe(false);
  });
  it("SESSION_COOKIE_SECURE ueberschreibt", () => {
    expect(isSecureRequest(h(), { SESSION_COOKIE_SECURE: "true" })).toBe(true);
    expect(isSecureRequest(h("https"), { SESSION_COOKIE_SECURE: "false" })).toBe(false);
  });
});
