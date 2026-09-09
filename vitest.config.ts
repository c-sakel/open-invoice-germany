import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // CI-Runner sind deutlich langsamer als lokale Laeufe (Timeouts bei 5 s in
    // api-log-retention und scheduler-routes) — 20 s je Test, 30 s je Hook.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    env: {
      // Separate Test-DB (löst relativ zum Schema-Verzeichnis auf -> prisma/test.db)
      DATABASE_URL: "file:./test.db",
    },
    // SQLite verträgt keine parallelen Writer -> Test-Files seriell
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
