import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, resetRateLimits, RateLimitError } from "@/lib/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("erlaubt genau `limit` Aufrufe, der naechste wirft", () => {
    const key = "test-key";
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(() => rateLimit(key, { limit: 10, windowMs: 60_000, now })).not.toThrow();
    }
    expect(() => rateLimit(key, { limit: 10, windowMs: 60_000, now })).toThrow(RateLimitError);
  });

  it("erlaubt nach Ablauf des Fensters wieder Aufrufe", () => {
    const key = "test-key-2";
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      rateLimit(key, { limit: 10, windowMs: 60_000, now });
    }
    expect(() => rateLimit(key, { limit: 10, windowMs: 60_000, now })).toThrow(RateLimitError);

    const later = now + 60_000;
    expect(() => rateLimit(key, { limit: 10, windowMs: 60_000, now: later })).not.toThrow();
  });

  it("nennt die verbleibende Wartezeit im Fehler", () => {
    const key = "test-key-3";
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      rateLimit(key, { limit: 10, windowMs: 60_000, now });
    }
    try {
      rateLimit(key, { limit: 10, windowMs: 60_000, now: now + 100 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(60_000 - 100);
    }
  });

  it("behandelt unterschiedliche Schluessel unabhaengig voneinander", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      rateLimit("key-a", { limit: 10, windowMs: 60_000, now });
    }
    expect(() => rateLimit("key-b", { limit: 10, windowMs: 60_000, now })).not.toThrow();
  });
});
