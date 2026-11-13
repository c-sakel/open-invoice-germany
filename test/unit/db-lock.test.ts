import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { isPostgresUrl } from "@/lib/db";
import { lockRow, lockRows } from "@/lib/db-lock";

const ORIGINAL = process.env.DATABASE_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

function fakeTx() {
  const fn = vi.fn().mockResolvedValue([]);
  return { tx: { $queryRawUnsafe: fn } as unknown as Prisma.TransactionClient, fn };
}

describe("lockRow", () => {
  it("sperrt unter Postgres genau eine Zeile", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    const { tx, fn } = fakeTx();
    await lockRow(tx, "Quote", "q1");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('SELECT 1 FROM "Quote" WHERE "id" = $1 FOR UPDATE', "q1");
  });

  it("ist unter SQLite ein No-op", async () => {
    process.env.DATABASE_URL = "file:./x.db";
    const { tx, fn } = fakeTx();
    await lockRow(tx, "Invoice", "i1");
    expect(fn).not.toHaveBeenCalled();
  });

  it("lehnt Tabellen ausserhalb der Whitelist ab", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    const { tx, fn } = fakeTx();
    await expect(lockRow(tx, 'User"; DROP TABLE x; --' as never, "a")).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("lockRows", () => {
  it("dedupliziert und sortiert nach Tabelle und id", async () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    const { tx, fn } = fakeTx();
    await lockRows(tx, [
      { table: "Quote", id: "b" },
      { table: "Invoice", id: "a" },
      { table: "Quote", id: "b" },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]).toEqual(['SELECT 1 FROM "Invoice" WHERE "id" = $1 FOR UPDATE', "a"]);
    expect(fn.mock.calls[1]).toEqual(['SELECT 1 FROM "Quote" WHERE "id" = $1 FOR UPDATE', "b"]);
  });
});

describe("isPostgresUrl", () => {
  it("erkennt Postgres-URLs", () => {
    expect(isPostgresUrl("postgresql://x")).toBe(true);
    expect(isPostgresUrl("postgres://x")).toBe(true);
    expect(isPostgresUrl("file:./x.db")).toBe(false);
    expect(isPostgresUrl(undefined)).toBe(false);
  });
});
