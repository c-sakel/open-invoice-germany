import { describe, it, expect } from "vitest";
import { safeRedirectPath } from "@/lib/http/safe-redirect";

describe("safeRedirectPath", () => {
  it("relative Pfade bleiben", () => {
    expect(safeRedirectPath("/rechnungen?x=1")).toBe("/rechnungen?x=1");
    expect(safeRedirectPath("/kunden/abc#x")).toBe("/kunden/abc#x");
  });
  it.each(["//evil.example", "/\\evil", "https://evil.example", "javascript:alert(1)", "", "/a\nb", "/a\\b"])(
    "faellt bei %j auf den Default zurueck",
    (v) => {
      expect(safeRedirectPath(v)).toBe("/rechnungen");
    },
  );
  it("undefined/null -> Fallback, eigener Fallback", () => {
    expect(safeRedirectPath(undefined)).toBe("/rechnungen");
    expect(safeRedirectPath(null, "/x")).toBe("/x");
  });
});
