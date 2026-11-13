import { Prisma } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { withChangeLogRetry } from "@/lib/chain-retry";

function p2002(target: unknown) {
  return new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x", meta: { target } });
}
const fast = { delayMs: () => 0 };

describe("withChangeLogRetry", () => {
  it("wiederholt bei P2002 auf orgId+prevHash", async () => {
    let n = 0;
    const r = await withChangeLogRetry(async () => {
      if (++n < 3) throw p2002(["orgId", "prevHash"]);
      return "ok";
    }, fast);
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });
  it("reicht andere Fehler sofort durch", async () => {
    let n = 0;
    await expect(withChangeLogRetry(async () => { n++; throw p2002(["invoiceId", "kind"]); }, fast)).rejects.toThrow("dup");
    await expect(withChangeLogRetry(async () => { n++; throw new Error("boom"); }, fast)).rejects.toThrow("boom");
    expect(n).toBe(2);
  });
  it("wirft nach Erschoepfung", async () => {
    let n = 0;
    await expect(withChangeLogRetry(async () => { n++; throw p2002(["orgId", "prevHash"]); }, { ...fast, attempts: 3 })).rejects.toThrow("dup");
    expect(n).toBe(3);
  });
  it("gibt vorhandenes Ergebnis zurueck, wenn alreadyDone greift", async () => {
    let n = 0;
    const r = await withChangeLogRetry(async () => { n++; throw p2002(["orgId", "prevHash"]); }, { ...fast, alreadyDone: async () => "da" });
    expect(r).toBe("da");
    expect(n).toBe(1);
  });
});
