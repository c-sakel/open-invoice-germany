import { vi } from "vitest";
import { guardClient } from "./tx-guard";

// Phase 17c: dbInternal/prisma in allen Tests mit dem Transaktions-Guard umhuellen.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, dbInternal: guardClient(actual.dbInternal), prisma: guardClient(actual.prisma) };
});
