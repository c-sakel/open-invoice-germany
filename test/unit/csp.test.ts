import { describe, it, expect, vi, afterEach } from "vitest";
import { applyCsp, buildCsp, cspHeaderName, cspModeFromEnv } from "@/lib/http/csp";

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
    it("ergibt enforce und warnt genau einmal", async () => {
      vi.resetModules(); // frisches Modul: der Warn-Merker ist zurueckgesetzt
      const fresh = await import("@/lib/http/csp");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(fresh.cspModeFromEnv("quatsch")).toBe("enforce");
      expect(fresh.cspModeFromEnv("noch-mehr")).toBe("enforce");
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("applyCsp auf Seitenpfaden", () => {
    afterEach(() => vi.unstubAllEnvs());
    it.each(["/angebot/abc", "/zahlen/abc", "/portal/abc", "/rechnungen", "/api/docs"])("%s traegt die Policy", (path) => {
      vi.stubEnv("SECURITY_CSP", "enforce");
      const res = new Response(null);
      applyCsp(res, path);
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    });
    it("API-Downloads behalten ihre eigene Policy", () => {
      const res = new Response(null);
      applyCsp(res, "/api/invoices/x/pdf");
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    });
  });
});
