import { describe, it, expect, vi } from "vitest";

describe("customerListWhere", () => {
  it("nutzt auf Postgres mode insensitive fuer alle fuenf Felder", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    const { customerListWhere } = await import("@/domain/customer/list");
    const where = customerListWhere("o1", "becker", false);
    expect(where.orgId).toBe("o1");
    expect(where.isArchived).toBe(false);
    const or = where.OR as Array<Record<string, { contains: string; mode?: string }>>;
    expect(or.map((o) => Object.keys(o)[0])).toEqual(["name", "customerNumber", "email", "city", "vatId"]);
    for (const o of or) expect(Object.values(o)[0]).toEqual({ contains: "becker", mode: "insensitive" });
    vi.unstubAllEnvs();
  });

  it("ohne q kein OR, archiviert zeigt auch Archivierte", async () => {
    const { customerListWhere } = await import("@/domain/customer/list");
    expect(customerListWhere("o1", undefined, false)).toEqual({ orgId: "o1", isArchived: false });
    expect(customerListWhere("o1", "  ", true)).toEqual({ orgId: "o1" });
  });
});
