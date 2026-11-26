import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

describe("next.config Sicherheitsheader", () => {
  it("setzt die festen Header fuer alle Pfade", async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toBeDefined();
    const rule = rules?.find((r) => r.source === "/:path*");
    const map = new Map((rule?.headers ?? []).map((h) => [h.key, h.value]));
    expect(map.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(map.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(map.get("Strict-Transport-Security")).not.toContain("includeSubDomains");
  });
});
