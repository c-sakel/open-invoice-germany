import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "@/app/api/live/route";

describe("GET /api/live", () => {
  it("liefert 200 {status: ok} ohne Zwischenspeicher", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("importiert weder Datenbank noch Health-Modul", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/live/route.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/db/);
    expect(src).not.toMatch(/@\/lib\/health/);
    expect(src).not.toMatch(/prisma/i);
  });
});
