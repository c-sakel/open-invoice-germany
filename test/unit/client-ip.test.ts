import { describe, it, expect, afterEach, vi } from "vitest";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

function h(init: Record<string, string>): Headers {
  return new Headers(init);
}

afterEach(() => {
  delete process.env.CLIENT_IP_SOURCE;
  delete process.env.TRUSTED_PROXY_COUNT;
  vi.restoreAllMocks();
});

describe("clientIpFromHeaders", () => {
  it("legacy (Default): cf-connecting-ip vor erstem x-forwarded-for-Eintrag", () => {
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.2" }))).toBe("203.0.113.1");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "198.51.100.2, 10.0.0.1" }))).toBe("198.51.100.2");
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });

  it("cf: nur cf-connecting-ip, gefaelschtes x-forwarded-for/x-real-ip wird ignoriert", () => {
    process.env.CLIENT_IP_SOURCE = "cf";
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }))).toBe("203.0.113.1");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }))).toBeNull();
  });

  it("x-real-ip: nur dieser Header", () => {
    process.env.CLIENT_IP_SOURCE = "x-real-ip";
    expect(clientIpFromHeaders(h({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "5.5.5.5" }))).toBe("203.0.113.5");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6" }))).toBeNull();
  });

  it("xff: rechter Eintrag, gefaelschte linke Eintraege zaehlen nicht", () => {
    process.env.CLIENT_IP_SOURCE = "xff";
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 9.9.9.9, 203.0.113.7", "cf-connecting-ip": "5.5.5.5" }))).toBe("203.0.113.7");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });

  it("xff mit TRUSTED_PROXY_COUNT=2: zweiter Eintrag von rechts; zu kurze Kette -> null", () => {
    process.env.CLIENT_IP_SOURCE = "xff";
    process.env.TRUSTED_PROXY_COUNT = "2";
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "10.0.0.1" }))).toBeNull();
  });

  it("ungueltiger TRUSTED_PROXY_COUNT faellt auf 1 zurueck", () => {
    process.env.CLIENT_IP_SOURCE = "xff";
    process.env.TRUSTED_PROXY_COUNT = "abc";
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("unbekannter Wert: legacy mit Warnung", () => {
    process.env.CLIENT_IP_SOURCE = "bogus";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(warn).toHaveBeenCalled();
  });
});
