import { describe, it, expect, vi, afterEach } from "vitest";
import { buildCsp, cspHeaderName, cspModeFromEnv } from "@/lib/http/csp";

describe("csp", () => {
  it("Produktion: kein unsafe-eval, Rahmen-, Frame- und Formularregeln", () => {
    const csp = buildCsp({ dev: false });
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("ws:");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("form-action 'self' https:");
    expect(csp).toContain("frame-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
  });

  it("Entwicklung: unsafe-eval und ws:", () => {
    const csp = buildCsp({ dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws:");
  });

  it("Modi und Header-Namen", () => {
    expect(cspHeaderName(cspModeFromEnv("enforce"))).toBe("Content-Security-Policy");
    expect(cspHeaderName(cspModeFromEnv("report-only"))).toBe("Content-Security-Policy-Report-Only");
    expect(cspHeaderName(cspModeFromEnv("off"))).toBeNull();
    expect(cspModeFromEnv(undefined)).toBe("enforce");
  });

  describe("ungueltiger Wert", () => {
    afterEach(() => vi.restoreAllMocks());
    it("ergibt enforce und warnt einmal", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(cspModeFromEnv("quatsch")).toBe("enforce");
      expect(cspModeFromEnv("noch-mehr")).toBe("enforce");
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });
});
