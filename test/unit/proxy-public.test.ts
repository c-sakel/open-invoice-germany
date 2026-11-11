import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { PUBLIC_PREFIXES, proxy } from "@/proxy";

describe("PUBLIC_PREFIXES", () => {
  it("enthaelt genau die oeffentlichen Praefixe fuer die Angebotsannahme", () => {
    expect(PUBLIC_PREFIXES).toContain("/angebot/");
    expect(PUBLIC_PREFIXES).toContain("/api/public/");
  });

  it("enthaelt keine weiteren, ueberraschenden Praefixe (Sicherheitsregel — nur die dokumentierten)", () => {
    expect(PUBLIC_PREFIXES).toEqual([
      "/login",
      "/setup",
      "/api/auth",
      "/api/cron",
      "/angebot/",
      "/api/public/",
      "/api/v1/",
      "/api/docs",
      "/api/branding",
    ]);
  });

  it("enthaelt /api/v1/ (Phase 10: Bearer-Auth im Wrapper, kein Cookie-Fallback)", () => {
    expect(PUBLIC_PREFIXES).toContain("/api/v1/");
  });

  it("enthaelt /api/docs (Phase 10, Task 4: Session-ODER-Bearer-Pruefung in der Route selbst)", () => {
    expect(PUBLIC_PREFIXES).toContain("/api/docs");
  });

  it("enthaelt /api/branding (Phase 12c, Task 2: Favicon/App-Logo vor der Session)", () => {
    expect(PUBLIC_PREFIXES).toContain("/api/branding");
  });
});

describe("/api/health (Phase 16a, Task 8)", () => {
  async function pass(pathname: string): Promise<boolean> {
    const res = await proxy(new NextRequest(`http://localhost${pathname}`));
    // Oeffentlich = durchgereicht (kein 401/Redirect).
    return res.status === 200 && res.headers.get("x-middleware-next") === "1";
  }

  it("ist exakt oeffentlich, nicht als Praefix", async () => {
    expect(PUBLIC_PREFIXES).not.toContain("/api/health");
    expect(await pass("/api/health")).toBe(true);
  });

  it("/api/health/x und /api/healthz bleiben geschuetzt (ohne Sitzung 401)", async () => {
    for (const p of ["/api/health/x", "/api/healthz"]) {
      const res = await proxy(new NextRequest(`http://localhost${p}`));
      expect(res.status, p).toBe(401);
    }
  });
});
