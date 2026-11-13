import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

/**
 * Phase 17b: Parallel-Lasttest unter PostgreSQL (scripts/test-postgres-race.sh).
 * Eigene Konfiguration: kein globalSetup (kein SQLite-Reset), Postgres-Client aus
 * tmp/pg-race/client statt des SQLite-Clients unter src/generated/prisma.
 */
if (!(process.env.DATABASE_URL ?? "").startsWith("postgres")) {
  throw new Error("vitest.postgres.config.ts: DATABASE_URL muss mit postgres beginnen (Aufruf ueber scripts/test-postgres-race.sh).");
}

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/postgres/**/*.pgtest.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      FX_AUTO_FETCH: "0",
      ARCHIVE_DIR: path.join(os.tmpdir(), "oig-race-archive"),
    },
  },
  resolve: {
    alias: [
      { find: "@/generated/prisma/client", replacement: path.join(root, "tmp/pg-race/client/client.ts") },
      { find: "@", replacement: path.join(root, "src") },
    ],
  },
});
